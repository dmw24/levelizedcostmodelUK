/***************************************************
 * model.js
 ***************************************************/

// Global solar profile array (8760 hours)
let solarProfile = [];
const HOURS_PER_YEAR = 8760;

// Load CSV on page load
window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: function(results) {
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. First 24 hrs:", solarProfile.slice(0, 24));
      runModel(); // run default scenario on load
    }
  });
};

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

  // Convert capacity units
  //  - 1 GW = 1000 MW
  //  - 1 MW = 1000 kW
  const solarCapMW = solarCapGW * 1000;        // from GW to MW
  const batteryCapMWh = batteryCapGWh * 1000;  // from GWh to MWh

  // 2) Dispatch model (1 GW baseload => 1000 MWh/h)
  let batterySoC = 0;
  const solarFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);

  const maxSolarAC = solarCapMW / inverterRatio; // MW AC limit

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // MWh/h
    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    solarFlow[h] = clippedSolarMW;

    let netLoad = demand - clippedSolarMW; 
    if (netLoad > 0) {
      // Discharge battery if possible
      if (batterySoC > 0) {
        const discharge = Math.min(netLoad, batterySoC);
        batteryFlow[h] = discharge;  // + => discharging
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
  const totalBatteryDischargeMWh = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  const totalDemandMWh = HOURS_PER_YEAR * 1000; // 8,760,000 MWh

  // 4) LCOE for each technology

  // a) Gas => capacity is 1 GW = 1000 MW, but CapEx in GBP/kW => multiply by 1000
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; 
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  // varOM + fuel => MWh * cost
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasAnnualFuel = totalGasMWh * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  const gasLcoe = (totalGasMWh > 0) 
    ? gasAnnualCost / (totalGasMWh ) 
    : 0;
  const gasCapexLcoe = (totalGasMWh > 0) 
    ? gasAnnualCapex / (totalGasMWh ) 
    : 0;
  const gasOpexLcoe = (totalGasMWh > 0) 
    ? (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / (totalGasMWh ) 
    : 0;

  // b) Solar => capacity in MW, CapEx in GBP/kW => multiply by 1000
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  const solarLcoe = (totalSolarMWh > 0)
    ? solarAnnualCost / (totalSolarMWh )
    : 0;
  const solarCapexLcoe = (totalSolarMWh > 0)
    ? solarAnnualCapex / (totalSolarMWh )
    : 0;
  const solarOpexLcoe = (totalSolarMWh > 0)
    ? solarAnnualFixedOM / (totalSolarMWh )
    : 0;

  // c) Battery => capacity in MWh, cost in GBP/kWh => multiply by 1000
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  // Hard-code battery lifetime to 25 yrs (or make it an input if you prefer)
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  // For O&M, we guess battery power rating = MWh / 4
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  const batteryLcoe = (totalBatteryDischargeMWh > 0)
    ? batteryAnnualCost / (totalBatteryDischargeMWh )
    : 0;
  const batteryCapexLcoe = (totalBatteryDischargeMWh > 0)
    ? batteryAnnualCapex / (totalBatteryDischargeMWh )
    : 0;
  const batteryOpexLcoe = (totalBatteryDischargeMWh > 0)
    ? batteryAnnualFixedOM / (totalBatteryDischargeMWh )
    : 0;

  // d) System LCOE => sum annual costs / total load
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / ( (totalDemandMWh ) );

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

  // Summary text
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

/** Summation helper */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/** Capital Recovery Factor */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** ========== Charts ========== */

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
      animation: false, // might help performance
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

// 3) January => bar chart for first 7 days
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

// 4) July => bar chart for ~mid-year (1 week)
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

// 5) LCOE Breakdown => stacked bar (capex vs. opex)
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
