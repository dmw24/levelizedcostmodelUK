/***************************************************
 * model.js
 * 1) LCOE math for gas: 
 *    - Fuel cost in GBP/MWh_f
 *    - Efficiency
 *    - Fixed + var O&M
 * 2) Hourly charts: single "Solar" flow
 * 3) "Generation" chart (horizontal) with 4 bars
 * 4) Single "System LCOE" bar at the bottom
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

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   // GBP/MWh_e
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 40;    // GBP/MWh_f
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
  //  - batteryFlow[h]: positive = discharge, negative = charge
  //  - gasFlow[h]
  //  - solarCurtailedFlow[h] (for generation chart)
  // For the HOURLY CHART, we only show total "Solar" each hour (clippedSolarMW).

  let batterySoC = 0;
  const solarUsedFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);
  const solarCurtailedFlow = new Array(HOURS_PER_YEAR).fill(0);

  // For the hourly chart
  const totalSolarFlow = new Array(HOURS_PER_YEAR).fill(0);

  // Max AC from solar after inverter ratio
  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1000 MWh/h for 1 GW
    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // For the chart, store total solar
    totalSolarFlow[h] = clippedSolarMW;

    // 1) Use solar to meet load directly
    const directSolarUsed = Math.min(demand, clippedSolarMW);
    solarUsedFlow[h] = directSolarUsed;
    const demandLeft = demand - directSolarUsed;

    // 2) leftover solar => can charge battery
    const leftoverSolar = clippedSolarMW - directSolarUsed;
    let batteryCharge = 0;
    if (leftoverSolar > 0) {
      const spaceInBattery = batteryCapMWh - batterySoC;
      batteryCharge = Math.min(leftoverSolar, spaceInBattery);
      if (batteryCharge > 0) {
        batterySoC += batteryCharge;
        batteryFlow[h] = -batteryCharge; // negative => charging
      }
    }

    // 3) any leftover is curtailed
    const leftoverAfterCharge = leftoverSolar - batteryCharge;
    if (leftoverAfterCharge > 0) {
      solarCurtailedFlow[h] = leftoverAfterCharge;
    }

    // 4) see if we can discharge battery for remaining demand
    let netLoad = demandLeft;
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
  const totalSolarUsed = sumArray(solarUsedFlow);
  const totalBatteryDischarge = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  const totalCurtailed = sumArray(solarCurtailedFlow);
  const totalSolarGen = sumArray(totalSolarFlow); // for reference
  const totalDemandMWh = HOURS_PER_YEAR * 1000;   // 8,760,000 MWh

  // 4) LCOE Calculations
  // a) Gas
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex;
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas; // GBP/yr

  // Fixed O&M
  const gasAnnualFixedOM = gasCapMW * gasFixedOM; 
  // Var O&M => totalGasMWh * gasVarOM
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  // Fuel => if gasFuel is in GBP/MWh_f
  const gasFuelConsumed = (gasEfficiency > 0) ? (totalGasMWh / gasEfficiency) : 0;
  const gasAnnualFuel = gasFuelConsumed * gasFuel;

  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  // Gas LCOE
  let gasLcoe = 0;
  if (totalGasMWh > 0) {
    gasLcoe = gasAnnualCost / totalGasMWh;
  }

  // b) Solar => only solarUsedFlow in denominator
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  let solarLcoe = 0;
  if (totalSolarUsed > 0) {
    solarLcoe = solarAnnualCost / totalSolarUsed;
  }

  // c) Battery => only battery discharge
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  let batteryLcoe = 0;
  if (totalBatteryDischarge > 0) {
    batteryLcoe = batteryAnnualCost / totalBatteryDischarge;
  }

  // System LCOE => total cost / total load
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh; // GBP/MWh

  // 5) Update CHARTS

  // a) Generation chart (horizontal)
  updateGenerationChart({
    gasMWh: totalGasMWh,
    solarUsedMWh: totalSolarUsed,
    batteryMWh: totalBatteryDischarge,
    curtailedMWh: totalCurtailed
  });

  // b) Yearly profile => stacked bar with Solar, Battery, Gas
  updateYearlyProfileChart(totalSolarFlow, batteryFlow, gasFlow);

  // c) January => stacked bar with Solar, Battery, Gas
  updateJanChart(totalSolarFlow, batteryFlow, gasFlow);

  // d) July => stacked bar with Solar, Battery, Gas
  updateJulChart(totalSolarFlow, batteryFlow, gasFlow);

  // e) Single bar for "System LCOE" => 6 segments: 
  //    Gas Capex, Gas Opex, Solar Capex, Solar Opex, Battery Capex, Battery Opex
  const gasCapexSystem = gasAnnualCapex / totalDemandMWh;
  const gasOpexSystem  = (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalDemandMWh;
  const solarCapexSystem = solarAnnualCapex / totalDemandMWh;
  const solarOpexSystem  = solarAnnualFixedOM / totalDemandMWh;
  const batteryCapexSystem = batteryAnnualCapex / totalDemandMWh;
  const batteryOpexSystem  = batteryAnnualFixedOM / totalDemandMWh;

  updateSystemLcoeChart({
    gasCapexSystem,
    gasOpexSystem,
    solarCapexSystem,
    solarOpexSystem,
    batteryCapexSystem,
    batteryOpexSystem
  });
}

/** Summation helper */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/** CRF => capital recovery factor */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** ========== Charts ========== */

// 1) Generation chart => horizontal bar: Gas, Used Solar, Battery, Curtailed
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
        data: [gasMWh / 1000, solarUsedMWh / 1000, batteryMWh / 1000, curtailedMWh / 1000],
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
          title: { display: false, text: "Resource" }
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

// 2) Yearly Profile => stacked bar with Solar, Battery, Gas
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

// 3) January => stacked bar with Solar, Battery, Gas
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

// 4) July => stacked bar with Solar, Battery, Gas
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

// 5) System LCOE Breakdown => single bar with 6 stacked segments
let systemLcoeChart;
function updateSystemLcoeChart({
  gasCapexSystem,
  gasOpexSystem,
  solarCapexSystem,
  solarOpexSystem,
  batteryCapexSystem,
  batteryOpexSystem
}) {
  const ctx = document.getElementById("systemLcoeChart").getContext("2d");
  if (systemLcoeChart) systemLcoeChart.destroy();

  systemLcoeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["System LCOE"],
      datasets: [
        {
          label: "Gas Capex",
          data: [gasCapexSystem],
          backgroundColor: "#f45d5d"
        },
        {
          label: "Gas Opex",
          data: [gasOpexSystem],
          backgroundColor: "#f45d5d88"
        },
        {
          label: "Solar Capex",
          data: [solarCapexSystem],
          backgroundColor: "#f4d44d"
        },
        {
          label: "Solar Opex",
          data: [solarOpexSystem],
          backgroundColor: "#f4d44d88"
        },
        {
          label: "Battery Capex",
          data: [batteryCapexSystem],
          backgroundColor: "#4db6e4"
        },
        {
          label: "Battery Opex",
          data: [batteryOpexSystem],
          backgroundColor: "#4db6e488"
        }
      ]
    },
    options: {
      responsive: true,
      indexAxis: "y", // single horizontal bar
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: "GBP/MWh" },
          beginAtZero: true
        },
        y: {
          stacked: true,
          title: { display: false, text: "System LCOE" }
        }
      },
      plugins: {
        title: {
          display: true,
          text: "System LCOE Breakdown (GBP/MWh)"
        },
        legend: { position: "bottom" }
      }
    }
  });
}
