/***************************************************
 * model.js
 * Corrected version with realistic LCOE calculation
 ***************************************************/

// We'll store the solar profile (8760 hours) in this array
let solarProfile = [];
const HOURS_PER_YEAR = 8760;

// Load CSV on page load
window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: function(results) {
      // Extract the "electricity" column as numeric
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. Sample (first 24h):", solarProfile.slice(0, 24));
      // Run model once the data is loaded, using default inputs
      runModel();
    }
  });
};

/**
 * Main LCOE function
 */
function runModel() {
  // 1) Read user inputs
  const solarCapGW = parseFloat(document.getElementById("solarCap").value) || 0;
  const batteryCapGWh = parseFloat(document.getElementById("batteryCap").value) || 0;

  const gasCapex = parseFloat(document.getElementById("gasCapex").value) || 800;       // GBP/kW
  const solarCapex = parseFloat(document.getElementById("solarCapex").value) || 450;   // GBP/kW
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200; // GBP/kWh

  const gasFixedOM = parseFloat(document.getElementById("gasFixedOM").value) || 18000; // GBP/MW/yr
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM = parseFloat(document.getElementById("batteryFixedOM").value) || 6000;

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   // GBP/MWh
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 40;    // GBP/MWh
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value) || 45) / 100;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value) || 8) / 100;
  const waccRenew = (parseFloat(document.getElementById("waccRenew").value) || 5) / 100;

  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value) || 35;

  // Convert capacities
  //  - 1 GW = 1000 MW
  //  - 1 MW = 1000 kW
  //  - 1 GWh = 1000 MWh
  //  - 1 MWh = 1000 kWh
  const solarCapMW = solarCapGW * 1000;         // GW -> MW
  const batteryCapMWh = batteryCapGWh * 1000;   // GWh -> MWh

  // 2) Dispatch Model (1 GW = 1000 MWh/h baseload)
  let batterySoC = 0; // MWh stored
  const solarFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);

  // Max AC from solar after inverter ratio
  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1000 MWh/h for 1 GW
    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);
    solarFlow[h] = clippedSolarMW;

    // Net load after solar
    let netLoad = demand - clippedSolarMW;

    if (netLoad > 0) {
      // Discharge battery if possible
      if (batterySoC > 0) {
        const discharge = Math.min(netLoad, batterySoC);
        batteryFlow[h] = discharge; // + => discharging
        batterySoC -= discharge;
        netLoad -= discharge;
      }
      // Remainder from gas
      if (netLoad > 0) {
        gasFlow[h] = netLoad;
        netLoad = 0;
      }
    } else {
      // Surplus => charge battery
      const surplus = -netLoad;
      const space = batteryCapMWh - batterySoC;
      if (space > 0) {
        const charge = Math.min(surplus, space);
        batterySoC += charge;
        batteryFlow[h] = -charge; // negative => charging
      }
    }
  }

  // 3) Summaries
  const totalSolarMWh = sumArray(solarFlow);
  // Only positive battery flow is discharge
  const totalBatteryDischargeMWh = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  // The total demand is 8760 * 1000 = 8,760,000 MWh
  const totalDemandMWh = HOURS_PER_YEAR * 1000;

  // 4) LCOE Calculations

  // a) Gas => capacity is 1 GW => 1000 MW
  //    gasCapex in GBP/kW => multiply MW by 1000
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; // 1,000 MW * 1,000 kW/MW * GBP/kW
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas; // GBP/yr
  const gasAnnualFixedOM = gasCapMW * gasFixedOM; // e.g. 1000 MW * 18000 GBP/MW/yr
  // variable + fuel => MWh * cost
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasAnnualFuel = totalGasMWh * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  // Gas LCOE => (GBP/yr) / (MWh/yr) => GBP/MWh
  let gasLcoe = 0;
  if (totalGasMWh > 0) {
    gasLcoe = gasAnnualCost / totalGasMWh;
  }

  // We'll store the split for the stacked chart
  const gasCapexLcoe = (totalGasMWh > 0) ? (gasAnnualCapex / totalGasMWh) : 0;
  const gasOpexLcoe  = (totalGasMWh > 0) ? ((gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalGasMWh) : 0;

  // b) Solar => capacity in MW, capex in GBP/kW => multiply by 1000
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  let solarLcoe = 0;
  if (totalSolarMWh > 0) {
    solarLcoe = solarAnnualCost / totalSolarMWh;
  }
  const solarCapexLcoe = (totalSolarMWh > 0) ? (solarAnnualCapex / totalSolarMWh) : 0;
  const solarOpexLcoe  = (totalSolarMWh > 0) ? (solarAnnualFixedOM / totalSolarMWh) : 0;

  // c) Battery => capacity in MWh, capex in GBP/kWh => multiply MWh by 1000
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  // Hard-code battery lifetime to 25 years (or make an input if you prefer)
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  // For O&M, guess battery MW rating => MWh/4 or similar
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  let batteryLcoe = 0;
  if (totalBatteryDischargeMWh > 0) {
    batteryLcoe = batteryAnnualCost / totalBatteryDischargeMWh;
  }
  const batteryCapexLcoe = (totalBatteryDischargeMWh > 0) ? (batteryAnnualCapex / totalBatteryDischargeMWh) : 0;
  const batteryOpexLcoe  = (totalBatteryDischargeMWh > 0) ? (batteryAnnualFixedOM / totalBatteryDischargeMWh) : 0;

  // d) System LCOE => sum of annual costs / total load MWh
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh; // GBP/MWh

  // 5) Update Charts
  updateAnnualMixChart(totalSolarMWh, totalBatteryDischargeMWh, totalGasMWh);
  updateYearlyProfileChart(solarFlow, batteryFlow, gasFlow);
  updateJanChart(solarFlow, batteryFlow, gasFlow);
  updateJulChart(solarFlow, batteryFlow, gasFlow);
  updateLcoeBreakdownChart({
    gasCapex: gasCapexLcoe,
    gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe,
    solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe,
    batteryOpex: batteryOpexLcoe
  });

  // 6) Summary
  const summaryDiv = document.getElementById("summary");
  summaryDiv.innerHTML = `
    <p><strong>Total Demand Met:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
    <p><strong>Solar Generation:</strong> ${Math.round(totalSolarMWh).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryDischargeMWh).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>System LCOE:</strong> ${systemLcoe.toFixed(2)} GBP/MWh</p>
    <p>
      <em>
        Gas LCOE: ${gasLcoe.toFixed(2)}, 
        Solar LCOE: ${solarLcoe.toFixed(2)}, 
        Battery LCOE: ${batteryLcoe.toFixed(2)}
      </em>
    </p>
  `;
}

/** Array sum helper */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/** Capital Recovery Factor => converts lump-sum capex to annual payment */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** === Charting === */

// 1) Annual Mix Pie
let annualMixChart;
function updateAnnualMixChart(solarMWh, batteryMWh, gasMWh) {
  const total = solarMWh + batteryMWh + gasMWh;
  const ctx = document.getElementById("annualMixChart").getContext("2d");
  if (annualMixChart) annualMixChart.destroy();

  annualMixChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: ["Solar", "Battery", "Gas"],
      datasets: [{
        data: [
          (solarMWh / total) * 100,
          (batteryMWh / total) * 100,
          (gasMWh / total) * 100
        ],
        backgroundColor: ["#f4d44d", "#4db6e4", "#f45d5d"]
      }]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: "Annual Generation Mix (%)"
        }
      }
    }
  });
}

// 2) Yearly Profile => stacked bar of 8760 hours
let yearlyProfileChart;
function updateYearlyProfileChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("yearlyProfileChart").getContext("2d");
  if (yearlyProfileChart) yearlyProfileChart.destroy();

  yearlyProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: [...Array(HOURS_PER_YEAR).keys()],
      datasets: [
        {
          label: "Solar",
          data: solarFlow,
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery",
          data: batteryFlow,
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasFlow,
          backgroundColor: "#f45d5d",
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      animation: false, // might help performance with 8760 bars
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          title: { display: true, text: "MWh/h" }
        }
      }
    }
  });
}

// 3) January => first 7 days => 168 hours
let janProfileChart;
function updateJanChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("janProfileChart").getContext("2d");
  if (janProfileChart) janProfileChart.destroy();

  const janStart = 0;
  const janEnd = 24 * 7;
  const labels = [...Array(janEnd - janStart).keys()];

  janProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Solar",
          data: solarFlow.slice(janStart, janEnd),
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery",
          data: batteryFlow.slice(janStart, janEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasFlow.slice(janStart, janEnd),
          backgroundColor: "#f45d5d",
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, title: { display: true, text: "Hour of January" } },
        y: { stacked: true, title: { display: true, text: "MWh/h" } }
      }
    }
  });
}

// 4) July => ~ mid-year => pick 7 days from end of June
let julProfileChart;
function updateJulChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("julProfileChart").getContext("2d");
  if (julProfileChart) julProfileChart.destroy();

  const julStart = 24 * (31 + 28 + 31 + 30 + 31 + 30); // end of June
  const julEnd = julStart + 24 * 7;
  const labels = [...Array(julEnd - julStart).keys()];

  julProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Solar",
          data: solarFlow.slice(julStart, julEnd),
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery",
          data: batteryFlow.slice(julStart, julEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasFlow.slice(julStart, julEnd),
          backgroundColor: "#f45d5d",
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, title: { display: true, text: "Hour of July" } },
        y: { stacked: true, title: { display: true, text: "MWh/h" } }
      }
    }
  });
}

// 5) LCOE Breakdown => stacked bar for Capex vs. Opex
let lcoeBreakdownChart;
function updateLcoeBreakdownChart(vals) {
  const {
    gasCapex, gasOpex,
    solarCapex, solarOpex,
    batteryCapex, batteryOpex
  } = vals;

  const ctx = document.getElementById("lcoeBreakdownChart").getContext("2d");
  if (lcoeBreakdownChart) lcoeBreakdownChart.destroy();

  lcoeBreakdownChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Gas", "Solar", "Battery"],
      datasets: [
        {
          label: "Capex (GBP/MWh)",
          data: [gasCapex, solarCapex, batteryCapex],
          backgroundColor: "#5555ff"
        },
        {
          label: "Opex (GBP/MWh)",
          data: [gasOpex, solarOpex, batteryOpex],
          backgroundColor: "#aaaaaa"
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          beginAtZero: true,
          title: { display: true, text: "GBP/MWh" }
        }
      }
    }
  });
}
