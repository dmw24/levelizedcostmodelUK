/***************************************************
 * model.js
 * - Distinguishes "solar used" vs. "solar curtailed"
 * - Sums "direct used + battery charging" into one "Solar" flow for charts
 * - Incorporates gas efficiency in fuel costs
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

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   // GBP/MWh (electric)
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 40;    // GBP/MWh (fuel)
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value) || 45) / 100;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value) || 8) / 100;
  const waccRenew = (parseFloat(document.getElementById("waccRenew").value) || 5) / 100;

  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value) || 35;

  // Convert capacities
  const solarCapMW = solarCapGW * 1000;         // 1 GW = 1000 MW
  const batteryCapMWh = batteryCapGWh * 1000;   // 1 GWh = 1000 MWh

  // 2) Dispatch Model (1 GW = 1000 MWh/h baseload)
  // We'll track:
  //  - solarUsedFlow[h]: solar used directly for load
  //  - solarCurtailedFlow[h]: leftover solar that cannot be used or stored
  //  - batteryFlow[h]: positive = discharge, negative = charge
  //  - gasFlow[h]
  //  - nonCurtailedSolarFlow[h] = solarUsedFlow + portion that goes into battery
  let batterySoC = 0; // MWh stored

  const solarUsedFlow = new Array(HOURS_PER_YEAR).fill(0);
  const solarCurtailedFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);

  // This new flow lumps together all solar except the curtailed portion
  const nonCurtailedSolarFlow = new Array(HOURS_PER_YEAR).fill(0);

  // Max AC from solar after inverter ratio
  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1000 MWh/h for 1 GW
    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // 1) Use solar to meet load directly
    const directSolarUsed = Math.min(demand, clippedSolarMW);
    solarUsedFlow[h] = directSolarUsed;
    const demandLeft = demand - directSolarUsed;

    // 2) leftover solar => can charge battery
    const leftoverSolar = clippedSolarMW - directSolarUsed;
    const spaceInBattery = batteryCapMWh - batterySoC;
    const batteryCharge = Math.min(leftoverSolar, spaceInBattery);

    if (batteryCharge > 0) {
      batterySoC += batteryCharge;
      batteryFlow[h] = -batteryCharge; // negative => charging
    }

    // 3) any solar left after battery is curtailment
    const leftoverAfterCharge = leftoverSolar - batteryCharge;
    solarCurtailedFlow[h] = leftoverAfterCharge > 0 ? leftoverAfterCharge : 0;

    // For the chart: "Solar" = directUsed + batteryCharge
    nonCurtailedSolarFlow[h] = directSolarUsed + batteryCharge;

    // 4) see if we can discharge battery for remaining demand
    let netLoad = demandLeft; // how much load remains
    if (netLoad > 0 && batterySoC > 0) {
      const batteryDischarge = Math.min(netLoad, batterySoC);
      batterySoC -= batteryDischarge;
      netLoad -= batteryDischarge;
      if (batteryDischarge > 0) {
        batteryFlow[h] = batteryDischarge; // positive => discharging
      }
    }

    // 5) remainder from gas
    if (netLoad > 0) {
      gasFlow[h] = netLoad;
      netLoad = 0;
    }
  }

  // 3) Summaries
  // For LCOE:
  // - "solarUsedFlow" is the portion that directly met load (for solar LCOE)
  // - "batteryFlow" (positive) is discharge MWh for battery LCOE
  // - "gasFlow" for gas LCOE
  // "nonCurtailedSolarFlow" is only for charting
  const totalSolarUsed = sumArray(solarUsedFlow);
  const totalBatteryDischarge = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  const totalCurtailed = sumArray(solarCurtailedFlow);
  const totalNonCurtailedSolar = sumArray(nonCurtailedSolarFlow); // for charts

  // The total demand is 8760 * 1000 = 8,760,000 MWh
  const totalDemandMWh = HOURS_PER_YEAR * 1000;

  // 4) LCOE Calculations

  // a) Gas
  // capacity = 1 GW => 1000 MW, gasCapex in GBP/kW => multiply by 1000
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex;
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;

  const gasAnnualFixedOM = gasCapMW * gasFixedOM; // GBP/yr

  // Now incorporate gas efficiency
  // totalGasMWh is the net electricity generated
  // MWh_fuel = totalGasMWh / efficiency
  const gasFuelConsumed = (gasEfficiency > 0) ? (totalGasMWh / gasEfficiency) : 0;
  const gasAnnualFuelCost = gasFuelConsumed * gasFuel; // GBP
  // Var O&M is per MWh_e
  const gasAnnualVarOMCost = totalGasMWh * gasVarOM; // GBP

  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOMCost + gasAnnualFuelCost;
  let gasLcoe = 0;
  if (totalGasMWh > 0) {
    gasLcoe = gasAnnualCost / totalGasMWh;
  }
  const gasCapexLcoe = (totalGasMWh > 0) ? (gasAnnualCapex / totalGasMWh) : 0;
  const gasOpexLcoe  = (totalGasMWh > 0) ? ((gasAnnualFixedOM + gasAnnualVarOMCost + gasAnnualFuelCost) / totalGasMWh) : 0;

  // b) Solar => only the portion used for load in denominator
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  let solarLcoe = 0;
  if (totalSolarUsed > 0) {
    solarLcoe = solarAnnualCost / totalSolarUsed;
  }
  const solarCapexLcoe = (totalSolarUsed > 0) ? (solarAnnualCapex / totalSolarUsed) : 0;
  const solarOpexLcoe  = (totalSolarUsed > 0) ? (solarAnnualFixedOM / totalSolarUsed) : 0;

  // c) Battery => only battery discharge MWh
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  // Approx battery MW => MWh / 4
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  let batteryLcoe = 0;
  if (totalBatteryDischarge > 0) {
    batteryLcoe = batteryAnnualCost / totalBatteryDischarge;
  }
  const batteryCapexLcoe = (totalBatteryDischarge > 0) ? (batteryAnnualCapex / totalBatteryDischarge) : 0;
  const batteryOpexLcoe  = (totalBatteryDischarge > 0) ? (batteryAnnualFixedOM / totalBatteryDischarge) : 0;

  // d) System LCOE => sum of annual costs / total load MWh
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh; // GBP/MWh

  // 5) Update Charts
  // For the annual mix, we'll show "Solar" as totalNonCurtailedSolar,
  // plus "Battery" (discharge), "Gas", "Solar Curtailed"
  updateAnnualMixChart(totalNonCurtailedSolar, totalBatteryDischarge, totalGasMWh, totalCurtailed);

  // For the hourly/yearly charts, pass nonCurtailedSolarFlow as "Solar"
  updateYearlyProfileChart(nonCurtailedSolarFlow, batteryFlow, gasFlow, solarCurtailedFlow);
  updateJanChart(nonCurtailedSolarFlow, batteryFlow, gasFlow, solarCurtailedFlow);
  updateJulChart(nonCurtailedSolarFlow, batteryFlow, gasFlow, solarCurtailedFlow);

  // LCOE breakdown
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
    <p><strong>System Demand:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
    <p><strong>Solar Used (direct):</strong> ${Math.round(totalSolarUsed).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryDischarge).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>Solar Curtailed:</strong> ${Math.round(totalCurtailed).toLocaleString()} MWh</p>
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

/** ========== Charts ========== */

// 1) Annual Mix Pie => 4 slices: "Solar" (non-curtailed), "Battery", "Gas", "Solar Curtailed"
let annualMixChart;
function updateAnnualMixChart(solarNonCurtailed, batteryDischarged, gasMWh, solarCurtailed) {
  const total = solarNonCurtailed + batteryDischarged + gasMWh + solarCurtailed;
  const ctx = document.getElementById("annualMixChart").getContext("2d");
  if (annualMixChart) annualMixChart.destroy();

  annualMixChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: ["Solar (non-curtailed)", "Battery", "Gas", "Solar Curtailed"],
      datasets: [{
        data: [
          (solarNonCurtailed / total) * 100,
          (batteryDischarged / total) * 100,
          (gasMWh / total) * 100,
          (solarCurtailed / total) * 100
        ],
        backgroundColor: ["#f4d44d", "#4db6e4", "#f45d5d", "#aaaaaa"]
      }]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: "Annual Flows (%)"
        }
      }
    }
  });
}

// 2) Yearly Profile => stacked bar with 4 flows:
//    "Solar" (non-curtailed) = direct + battery charge
//    "Battery" (positive=discharge, negative=charge)
//    "Gas"
//    "Solar Curtailed"
let yearlyProfileChart;
function updateYearlyProfileChart(solarFlow, batteryFlow, gasFlow, solarCurtailedFlow) {
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
        },
        {
          label: "Solar Curtailed",
          data: solarCurtailedFlow,
          backgroundColor: "#aaaaaa",
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
function updateJanChart(solarFlow, batteryFlow, gasFlow, solarCurtailedFlow) {
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
        },
        {
          label: "Solar Curtailed",
          data: solarCurtailedFlow.slice(janStart, janEnd),
          backgroundColor: "#aaaaaa",
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

// 4) July => pick 7 days from end of June
let julProfileChart;
function updateJulChart(solarFlow, batteryFlow, gasFlow, solarCurtailedFlow) {
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
        },
        {
          label: "Solar Curtailed",
          data: solarCurtailedFlow.slice(julStart, julEnd),
          backgroundColor: "#aaaaaa",
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
