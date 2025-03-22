/***************************************************
 * model.js
 * 
 * 1) LCOE math (Gas w/ efficiency)
 * 2) Hourly charts: single "Solar" flow
 * 3) Generation horizontal bar: Gas, Used Solar, Battery, Curtailed
 * 4) Single stacked bar for total LCOE breakdown:
 *    Gas Capex, Gas Opex, Solar Capex, Solar Opex, Battery Capex, Battery Opex
 * 5) Removed textual summary
 ***************************************************/

let solarProfile = [];
const HOURS_PER_YEAR = 8760;

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
  const solarCapGW = parseFloat(document.getElementById("solarCap").value) || 0;
  const batteryCapGWh = parseFloat(document.getElementById("batteryCap").value) || 0;

  const gasCapex = parseFloat(document.getElementById("gasCapex").value) || 800;       
  const solarCapex = parseFloat(document.getElementById("solarCapex").value) || 450;   
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200;

  const gasFixedOM = parseFloat(document.getElementById("gasFixedOM").value) || 18000; 
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM = parseFloat(document.getElementById("batteryFixedOM").value) || 6000;

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 40;    
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
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; 
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
  let gasLcoe = (totalGasMWh > 0) ? gasAnnualCost / totalGasMWh : 0;

  // b) Solar
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  let solarLcoe = (totalSolarUsed > 0) ? solarAnnualCost / totalSolarUsed : 0;

  // c) Battery
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  let batteryLcoe = (totalBatteryDischarge > 0) ? batteryAnnualCost / totalBatteryDischarge : 0;

  // d) System LCOE => sum of annual costs / total demand
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

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

  // e) Single bar with 6 segments for total LCOE
  //    Each sub-component is cost / totalDemandMWh
  const gasCapexPerMWh    = gasAnnualCapex / totalDemandMWh;
  const gasOpexPerMWh     = (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalDemandMWh;
  const solarCapexPerMWh  = solarAnnualCapex / totalDemandMWh;
  const solarOpexPerMWh   = solarAnnualFixedOM / totalDemandMWh;
  const batteryCapexPerMWh= batteryAnnualCapex / totalDemandMWh;
  const batteryOpexPerMWh = batteryAnnualFixedOM / totalDemandMWh;

  updateSystemLcoeChart({
    gasCapex: gasCapexPerMWh,
    gasOpex: gasOpexPerMWh,
    solarCapex: solarCapexPerMWh,
    solarOpex: solarOpexPerMWh,
    batteryCapex: batteryCapexPerMWh,
    batteryOpex: batteryOpexPerMWh
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

// 5) System LCOE Breakdown => single bar with 6 segments
let systemLcoeChart;
function updateSystemLcoeChart(vals) {
  const {
    gasCapex,
    gasOpex,
    solarCapex,
    solarOpex,
    batteryCapex,
    batteryOpex
  } = vals;

  const ctx = document.getElementById("systemLcoeChart").getContext("2d");
  if (systemLcoeChart) systemLcoeChart.destroy();

  systemLcoeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["System LCOE"],
      datasets: [
        {
          label: "Gas Capex",
          data: [gasCapex],
          backgroundColor: "#ff7777",
          stack: "stack"
        },
        {
          label: "Gas Opex",
          data: [gasOpex],
          backgroundColor: "#ffaaaa",
          stack: "stack"
        },
        {
          label: "Solar Capex",
          data: [solarCapex],
          backgroundColor: "#ffd85c",
          stack: "stack"
        },
        {
          label: "Solar Opex",
          data: [solarOpex],
          backgroundColor: "#fff1b8",
          stack: "stack"
        },
        {
          label: "Battery Capex",
          data: [batteryCapex],
          backgroundColor: "#66ccff",
          stack: "stack"
        },
        {
          label: "Battery Opex",
          data: [batteryOpex],
          backgroundColor: "#b3e6ff",
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Total LCOE Breakdown (GBP/MWh)"
        }
      },
      scales: {
        x: {
          stacked: true
        },
        y: {
          stacked: true,
          beginAtZero: true,
          title: { display: true, text: "GBP/MWh" }
        }
      }
    }
  });
}
