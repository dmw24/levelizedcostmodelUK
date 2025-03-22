/***************************************************
 * model.js
 * 
 * - Gas capacity fixed at 1 GW (1000 MW)
 * - Reads all user inputs for CapEx, O&M, WACC, efficiency, etc.
 * - Dispatch model to supply 1 GW baseload, plus battery/solar
 * - Final cost chart: horizontal bars for Capex, Opex, Total
 * - Below the chart: "Total levelized system cost: XX GBP/MWh"
 ***************************************************/

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
      console.log("Solar profile loaded. First 24h:", solarProfile.slice(0, 24));
      // Run model once data is loaded
      runModel();
    }
  });
};

function runModel() {
  // === 1) Grab user inputs ===
  // Gas capacity is fixed: 1 GW => 1000 MW
  const gasCapMW = 1000;

  // Solar / battery
  const solarCapGW = parseFloat(document.getElementById("solarCap").value) || 0;
  const batteryCapGWh = parseFloat(document.getElementById("batteryCap").value) || 0;
  const solarCapMW = solarCapGW * 1000;
  const batteryCapMWh = batteryCapGWh * 1000;

  // Costs
  const gasCapex = parseFloat(document.getElementById("gasCapex").value) || 800;
  const solarCapex = parseFloat(document.getElementById("solarCapex").value) || 450;
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200;

  const gasFixedOM = parseFloat(document.getElementById("gasFixedOM").value) || 18000;
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM = parseFloat(document.getElementById("batteryFixedOM").value) || 6000;

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 27;
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value) || 45) / 100;

  // Other
  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value) || 7.5) / 100;
  const waccRenew = (parseFloat(document.getElementById("waccRenew").value) || 5) / 100;
  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value) || 35;

  // === 2) Dispatch Model ===
  let batterySoC = 0;
  const solarUsedFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);
  const solarCurtailedFlow = new Array(HOURS_PER_YEAR).fill(0);

  // For the hourly chart, we show total clipped solar
  const totalSolarFlow = new Array(HOURS_PER_YEAR).fill(0);

  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1 GW => 1000 MWh/h
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    totalSolarFlow[h] = clippedSolarMW;

    // Use solar
    const directSolarUsed = Math.min(demand, clippedSolarMW);
    solarUsedFlow[h] = directSolarUsed;
    const demandLeft = demand - directSolarUsed;

    // Battery charging
    const leftoverSolar = clippedSolarMW - directSolarUsed;
    let batteryCharge = 0;
    if (leftoverSolar > 0) {
      const space = batteryCapMWh - batterySoC;
      batteryCharge = Math.min(leftoverSolar, space);
      if (batteryCharge > 0) {
        batterySoC += batteryCharge;
        batteryFlow[h] = -batteryCharge; // negative => charging
      }
    }
    const leftoverAfterCharge = leftoverSolar - batteryCharge;
    if (leftoverAfterCharge > 0) {
      solarCurtailedFlow[h] = leftoverAfterCharge;
    }

    // Battery discharge
    let netLoad = demandLeft;
    if (netLoad > 0 && batterySoC > 0) {
      const discharge = Math.min(netLoad, batterySoC);
      batterySoC -= discharge;
      netLoad -= discharge;
      if (discharge > 0) {
        batteryFlow[h] = discharge; // positive => discharging
      }
    }

    // Gas if load remains
    if (netLoad > 0) {
      gasFlow[h] = netLoad;
      netLoad = 0;
    }
  }

  // === 3) Summaries ===
  const totalSolarUsed = sumArray(solarUsedFlow);
  const totalBatteryDischarge = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  const totalCurtailed = sumArray(solarCurtailedFlow);
  const totalSolarGen = sumArray(totalSolarFlow);

  const totalDemandMWh = HOURS_PER_YEAR * 1000; // 1 GW * 8760h

  // === 4) Cost & "Levelized System Cost" ===

  // Gas cost
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; 
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasFuelConsumed = (gasEfficiency > 0) ? (totalGasMWh / gasEfficiency) : 0;
  const gasAnnualFuel = gasFuelConsumed * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;

  // Solar cost
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;

  // Battery cost
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25); // 25-year assumption
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4; // simplistic assumption
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;

  // Sum total cost
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const levelizedSystemCost = totalAnnualCost / totalDemandMWh; // GBP/MWh

  // Separate out capex vs. opex
  const totalCapex = gasAnnualCapex + solarAnnualCapex + batteryAnnualCapex;
  const totalOpex = (
    (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel)
    + solarAnnualFixedOM
    + batteryAnnualFixedOM
  );
  const systemCapex = totalCapex / totalDemandMWh;
  const systemOpex = totalOpex / totalDemandMWh;
  const systemTotal = systemCapex + systemOpex;

  // === 5) Update Charts ===
  updateGenerationChart({
    gasMWh: totalGasMWh,
    solarUsedMWh: totalSolarUsed,
    batteryMWh: totalBatteryDischarge,
    curtailedMWh: totalCurtailed
  });

  updateYearlyProfileChart(totalSolarFlow, batteryFlow, gasFlow);
  updateJanChart(totalSolarFlow, batteryFlow, gasFlow);
  updateJulChart(totalSolarFlow, batteryFlow, gasFlow);

  // Final horizontal bar
  updateSystemCostChart({
    capexVal: systemCapex,
    opexVal: systemOpex,
    totalVal: systemTotal
  });

  // Show text below chart
  const resultDiv = document.getElementById("levelizedCostResult");
  resultDiv.innerHTML = `Total levelized system cost: ${systemTotal.toFixed(2)} GBP/MWh`;
}

/** Helpers */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** ========== Charts ========== */

// 1) Generation horizontal bar => 4 bars: Gas, Used Solar, Battery, Curtailed
let generationChart;
function updateGenerationChart({ gasMWh, solarUsedMWh, batteryMWh, curtailedMWh }) {
  const ctx = document.getElementById("annualMixChart").getContext("2d");
  if (generationChart) generationChart.destroy();

  generationChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Gas", "Used Solar", "Battery", "Curtailed Solar"],
      datasets: [{
        label: "Total GWh",
        data: [
          gasMWh / 1000,
          solarUsedMWh / 1000,
          batteryMWh / 1000,
          curtailedMWh / 1000
        ],
        backgroundColor: ["#f45d5d", "#f4d44d", "#4db6e4", "#aaaaaa"]
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      scales: {
        x: {
          title: { display: true, text: "GWh" },
          beginAtZero: true
        },
        y: {
          title: { display: false }
        }
      },
      plugins: {
        title: {
          display: true,
          text: "Annual Generation (GWh)"
        }
      }
    }
  });
}

// 2) Yearly Profile => stacked bar with 3 flows: Solar, Battery, Gas
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
      animation: false,
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: "Hour of Year" }
        },
        y: {
          stacked: true,
          title: { display: true, text: "MWh/h" }
        }
      }
    }
  });
}

// 3) January => bar chart for first 7 days => 168 hours
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
        x: {
          stacked: true,
          title: { display: true, text: "Hour of January" }
        },
        y: {
          stacked: true,
          title: { display: true, text: "MWh/h" }
        }
      }
    }
  });
}

// 4) July => bar chart for ~mid-year => pick 7 days from end of June
let julProfileChart;
function updateJulChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("julProfileChart").getContext("2d");
  if (julProfileChart) julProfileChart.destroy();

  const julStart = 24 * (31 + 28 + 31 + 30 + 31 + 30);
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
        x: {
          stacked: true,
          title: { display: true, text: "Hour of July" }
        },
        y: {
          stacked: true,
          title: { display: true, text: "MWh/h" }
        }
      }
    }
  });
}

// 5) Horizontal bar for Capex, Opex, Total
let systemCostChart;
function updateSystemCostChart({ capexVal, opexVal, totalVal }) {
  const ctx = document.getElementById("systemCostChart").getContext("2d");
  if (systemCostChart) systemCostChart.destroy();

  systemCostChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Capex", "Opex", "Total"],
      datasets: [{
        label: "GBP/MWh",
        data: [capexVal, opexVal, totalVal],
        backgroundColor: ["#66CC99", "#FFCC66", "#9999FF"]
      }]
    },
    options: {
      indexAxis: "y", // horizontal
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Levelized System Cost Breakdown"
        },
        legend: { display: false }
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "GBP/MWh" }
        },
        y: {
          title: { display: false }
        }
      }
    }
  });
}


