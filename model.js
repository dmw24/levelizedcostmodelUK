/***************************************************
 * model.js
 * 1) LCOE math corrected for gas:
 *    - We treat gasFuel as GBP per MWh_fuel
 *    - Incorporate efficiency => MWh_f = MWh_e / efficiency
 *    - Summation: capex + fixed O&M + var O&M + fuel
 * 2) Hourly charts show only ONE "Solar" flow (clipped total),
 *    ignoring whether it was used, charged a battery, or curtailed.
 * 3) We add a new "Generation" horizontal bar chart with 4 bars:
 *    Gas, Used Solar, Battery, Curtailed Solar.
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
  //  - solarCurtailedFlow[h]
  // But for the HOURLY CHARTS, we just want "totalSolarFlow[h]" = clippedSolarMW
  // so there's no distinction in the final stacked bar.

  let batterySoC = 0; // MWh stored
  const solarUsedFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);
  const solarCurtailedFlow = new Array(HOURS_PER_YEAR).fill(0);

  // We'll store a separate "totalSolarFlow[h]" for charting (the entire clipped solar)
  const totalSolarFlow = new Array(HOURS_PER_YEAR).fill(0);

  // Max AC from solar after inverter ratio
  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1000 MWh/h for 1 GW
    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // For the hourly chart, we want total solar (used + battery + curtailed) as one flow
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

    // 3) any solar left after battery is curtailment
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
  // For LCOE denominators:
  // - "solarUsedFlow" is the portion that directly met load
  // - "batteryFlow" (positive) is discharge MWh for battery
  // - "gasFlow" for gas
  // - "solarCurtailedFlow" is leftover
  // The total demand is 8760 * 1000 = 8,760,000 MWh

  const totalSolarUsed = sumArray(solarUsedFlow);
  const totalBatteryDischarge = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  const totalCurtailed = sumArray(solarCurtailedFlow);

  // For the charts, we have totalSolarFlow (hourly) => sum that up if needed
  const totalSolarGen = sumArray(totalSolarFlow);

  const totalDemandMWh = HOURS_PER_YEAR * 1000; // 8,760,000 MWh

  // 4) LCOE Calculations
  // a) Gas
  // capacity = 1 GW => 1000 MW, gasCapex in GBP/kW => multiply by 1000
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; // e.g. 1000 MW * 1000 kW/MW * 800 GBP/kW
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas; // GBP/yr

  // Fixed O&M (annual)
  const gasAnnualFixedOM = gasCapMW * gasFixedOM; // e.g. 1000 MW * 18000 GBP/MW/yr => 18e6 GBP/yr

  // Variable O&M => net MWh output
  const gasAnnualVarOM = totalGasMWh * gasVarOM; // e.g. 4 GBP/MWh * totalGasMWh

  // Fuel cost => if gasFuel is in GBP/MWh_f, then MWh_f = totalGasMWh / efficiency
  let gasFuelConsumed = 0;
  if (gasEfficiency > 0) {
    gasFuelConsumed = totalGasMWh / gasEfficiency;
  }
  const gasAnnualFuel = gasFuelConsumed * gasFuel; // e.g. 40 GBP/MWh_f * MWh_f

  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  let gasLcoe = 0;
  if (totalGasMWh > 0) {
    gasLcoe = gasAnnualCost / totalGasMWh; // GBP/MWh
  }

  // b) Solar => only the portion used for load
  const solarCapexTotal = solarCapMW * 1000 * solarCapex; // MW -> kW
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  let solarLcoe = 0;
  if (totalSolarUsed > 0) {
    solarLcoe = solarAnnualCost / totalSolarUsed;
  }

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

  // d) System LCOE => sum of annual costs / total load MWh
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh; // GBP/MWh

  // 5) Update CHARTS

  // a) "Generation" horizontal bar chart with 4 bars:
  //    1) Gas
  //    2) Used Solar
  //    3) Battery
  //    4) Curtailed Solar
  updateGenerationChart({
    gasMWh: totalGasMWh,
    solarUsedMWh: totalSolarUsed,
    batteryMWh: totalBatteryDischarge,
    curtailedMWh: totalCurtailed
  });

  // b) Yearly (hourly) profile => stacked bar with:
  //    - Solar (the entire clipped solar each hour)
  //    - Battery (+/-)
  //    - Gas
  // We do NOT show curtailed separately, as requested
  updateYearlyProfileChart(totalSolarFlow, batteryFlow, gasFlow);

  // c) January (7 days)
  updateJanChart(totalSolarFlow, batteryFlow, gasFlow);

  // d) July (7 days mid-year)
  updateJulChart(totalSolarFlow, batteryFlow, gasFlow);

  // e) LCOE breakdown chart => stacked bar (capex vs. opex) for Gas, Solar, Battery
  updateLcoeBreakdownChart({
    gasCapex: (gasAnnualCapex / (totalGasMWh || 1)),
    gasOpex: ((gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / (totalGasMWh || 1)),
    solarCapex: (solarAnnualCapex / (totalSolarUsed || 1)),
    solarOpex: (solarAnnualFixedOM / (totalSolarUsed || 1)),
    batteryCapex: (batteryAnnualCapex / (totalBatteryDischarge || 1)),
    batteryOpex: (batteryAnnualFixedOM / (totalBatteryDischarge || 1))
  });

  // 6) Summary
  const summaryDiv = document.getElementById("summary");
  summaryDiv.innerHTML = `
    <p><strong>Total Demand:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
    <p><strong>Solar Used (direct):</strong> ${Math.round(totalSolarUsed).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryDischarge).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>Solar Curtailed:</strong> ${Math.round(totalCurtailed).toLocaleString()} MWh</p>
    <p><strong>Total Solar (Hourly Chart):</strong> ${Math.round(totalSolarGen).toLocaleString()} MWh</p>
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

/** ========== Charting ========== */

// 1) "Generation" horizontal bar chart => 4 bars: Gas, Used Solar, Battery, Curtailed
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
      indexAxis: "y", // horizontal bar
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

// 2) Yearly Profile => stacked bar with 3 flows: Solar, Battery, Gas
//    (No separate "curtailed" in the stacked chart)
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
