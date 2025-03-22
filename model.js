/***************************************************
 * model.js
 * 
 * 1) Gas capacity is fixed at 1 GW
 * 2) Default gas price: 27 GBP/MWh
 * 3) Gas Efficiency input is in O&M group
 * 4) Waterfall LCOE chart: 3 bars (Capex, Opex, Total),
 *    each with data labels on top
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
  // 1) Read user inputs
  // Gas capacity is fixed = 1 GW => 1000 MW
  const gasCapMW = 1000;

  const solarCapGW = parseFloat(document.getElementById("solarCap").value) || 0;
  const batteryCapGWh = parseFloat(document.getElementById("batteryCap").value) || 0;

  const gasCapex = parseFloat(document.getElementById("gasCapex").value) || 800;       
  const solarCapex = parseFloat(document.getElementById("solarCapex").value) || 450;   
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200;

  const gasFixedOM = parseFloat(document.getElementById("gasFixedOM").value) || 18000; 
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM = parseFloat(document.getElementById("batteryFixedOM").value) || 6000;

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 27;    
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value) || 45) / 100;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value) || 8) / 100;
  const waccRenew = (parseFloat(document.getElementById("waccRenew").value) || 5) / 100;

  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value) || 35;

  // Convert capacity units
  const solarCapMW = solarCapGW * 1000;       
  const batteryCapMWh = batteryCapGWh * 1000; 

  // 2) Dispatch Model
  let batterySoC = 0;
  const solarUsedFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);
  const solarCurtailedFlow = new Array(HOURS_PER_YEAR).fill(0);

  // For the hourly chart, just show total clipped solar
  const totalSolarFlow = new Array(HOURS_PER_YEAR).fill(0);

  // Gas capacity is 1000 MW, but we don't let user change it
  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; 
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // For the chart
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

    // Gas
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

  const totalDemandMWh = HOURS_PER_YEAR * 1000; 

  // 4) LCOE
  // a) Gas
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; // e.g. 1000 MW * 1000 kW/MW * 800 GBP/kW
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  let gasFuelConsumed = 0;
  if (gasEfficiency > 0) {
    gasFuelConsumed = totalGasMWh / gasEfficiency; 
  }
  const gasAnnualFuel = gasFuelConsumed * gasFuel; 
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;

  // b) Solar
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;

  // c) Battery
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;

  // Annual total cost
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

  // We'll define separate "capex portion" and "opex portion" for the entire system
  // so we can do a "waterfall" with 3 bars: capex, opex, total
  // - systemCapex = (gasAnnualCapex + solarAnnualCapex + batteryAnnualCapex) / totalDemandMWh
  // - systemOpex = ( (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) + solarAnnualFixedOM + batteryAnnualFixedOM ) / totalDemandMWh
  // - total = systemCapex + systemOpex (should match systemLcoe)
  const systemCapex = (gasAnnualCapex + solarAnnualCapex + batteryAnnualCapex) / totalDemandMWh;
  const systemOpex  = (
    (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) +
    solarAnnualFixedOM +
    batteryAnnualFixedOM
  ) / totalDemandMWh;
  // The sum
  const systemTotal = systemCapex + systemOpex; // should ~ systemLcoe

  // 5) Update Charts

  // a) Generation horizontal bar
  updateGenerationChart({
    gasMWh: totalGasMWh,
    solarUsedMWh: totalSolarUsed,
    batteryMWh: totalBatteryDischarge,
    curtailedMWh: totalCurtailed
  });

  // b) Yearly profile => solar, battery, gas
  updateYearlyProfileChart(totalSolarFlow, batteryFlow, gasFlow);

  // c) January
  updateJanChart(totalSolarFlow, batteryFlow, gasFlow);

  // d) July
  updateJulChart(totalSolarFlow, batteryFlow, gasFlow);

  // e) Waterfall LCOE chart => 3 bars: [Capex, Opex, Total]
  updateSystemLcoeChart({
    capexVal: systemCapex,
    opexVal: systemOpex,
    totalVal: systemTotal
  });
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

/** === Charting === */

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

// 5) Waterfall LCOE chart => 3 bars: Capex, Opex, Total
let systemLcoeChart;
function updateSystemLcoeChart({ capexVal, opexVal, totalVal }) {
  const ctx = document.getElementById("systemLcoeChart").getContext("2d");
  if (systemLcoeChart) systemLcoeChart.destroy();

  systemLcoeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Capex", "Opex", "Total"],
      datasets: [
        {
          label: "GBP/MWh",
          data: [capexVal, opexVal, totalVal],
          backgroundColor: ["#66CC99", "#FFCC66", "#9999FF"]
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "Total LCOE Waterfall"
        },
        // Show numeric labels on top of each bar
        datalabels: {
          anchor: "end",
          align: "start",
          offset: 5,
          formatter: function(value) {
            return value.toFixed(2);
          }
        }
      },
      scales: {
        x: {
          title: { display: false },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "GBP/MWh" }
        }
      }
    }
  });
}
