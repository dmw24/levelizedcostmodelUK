/***************************************************
 * model.js
 * Revised so only solar directly used for load
 * is counted as "solar generation."
 ***************************************************/

let solarProfile = [];       // 8760-hour array of [0..1] multipliers
const HOURS_PER_YEAR = 8760;

/**
 * On page load, parse the CSV with PapaParse,
 * then auto-run the model once loaded.
 */
window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: (results) => {
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded:", solarProfile.slice(0, 24));
      // Run the model with default UI inputs
      runModel();
    }
  });
};

/**
 * Main LCOE function triggered by "Run Model" button
 */
function runModel() {
  // === 1) Read user inputs ===
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

  // === Unit conversions ===
  // 1 GW = 1000 MW; 1 MW = 1000 kW
  // 1 GWh = 1000 MWh; 1 MWh = 1000 kWh
  const solarCapMW = solarCapGW * 1000;          // from GW to MW
  const batteryCapMWh = batteryCapGWh * 1000;    // from GWh to MWh

  // === 2) Dispatch model with refined logic ===
  // We want to track:
  //  - solarUsed[h]: portion of solar directly used for load
  //  - batteryOut[h]: battery discharge that meets load
  //  - gasUsed[h]: gas that meets load
  //  - batteryIn[h]: solar used to charge battery (negative in chart)
  //  - curtailment (leftover solar not used or stored)
  // The load each hour = 1000 MWh/h for 1 GW.

  let batterySoC = 0; // MWh state-of-charge
  const solarUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryOut = new Array(HOURS_PER_YEAR).fill(0);
  const gasUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryIn = new Array(HOURS_PER_YEAR).fill(0); // negative => charging

  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // MWh/h

    // Potential solar (clipped)
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // 1) Use as much solar as possible to meet load
    const solarToLoad = Math.min(clippedSolarMW, demand);
    solarUsed[h] = solarToLoad;
    demand -= solarToLoad;

    // 2) Surplus solar leftover
    let leftoverSolar = clippedSolarMW - solarToLoad;

    // 3) Charge battery with leftover solar
    if (leftoverSolar > 0 && batterySoC < batteryCapMWh) {
      const availableSpace = batteryCapMWh - batterySoC;
      const charge = Math.min(leftoverSolar, availableSpace);
      batterySoC += charge;
      leftoverSolar -= charge;
      batteryIn[h] = -charge; // negative => charging
    }

    // leftoverSolar is now curtailed if any remains

    // 4) If there's still demand, try discharging battery
    if (demand > 0 && batterySoC > 0) {
      const discharge = Math.min(demand, batterySoC);
      batterySoC -= discharge;
      demand -= discharge;
      batteryOut[h] = discharge; // + => meets load
    }

    // 5) If there's still demand, meet it with gas
    if (demand > 0) {
      gasUsed[h] = demand;
      demand = 0;
    }
    // done for hour h
  }

  // Summaries
  const totalSolarUsedMWh = sumArray(solarUsed);                   // directly used solar
  const totalBatteryDischargeMWh = sumArray(batteryOut);           // battery output
  const totalGasMWh = sumArray(gasUsed);
  const totalDemandMWh = HOURS_PER_YEAR * 1000; // 8,760,000 MWh

  // === 3) LCOE Calculations ===
  // a) Gas
  const gasCapMW = 1000; // 1 GW
  // Gas capex in GBP/kW => multiply by 1000 MW => 1,000 MW * 1000 kW/MW
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; 
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  // variable + fuel => totalGasMWh
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasAnnualFuel = totalGasMWh * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  const gasLcoe = (totalGasMWh > 0) ? (gasAnnualCost / totalGasMWh) : 0;
  const gasCapexLcoe = (totalGasMWh > 0) ? (gasAnnualCapex / totalGasMWh) : 0;
  const gasOpexLcoe  = (totalGasMWh > 0) ? ((gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalGasMWh) : 0;

  // b) Solar
  // capacity in MW, cost in GBP/kW => multiply by 1000
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  const solarLcoe = (totalSolarUsedMWh > 0) ? (solarAnnualCost / totalSolarUsedMWh) : 0;
  const solarCapexLcoe = (totalSolarUsedMWh > 0) ? (solarAnnualCapex / totalSolarUsedMWh) : 0;
  const solarOpexLcoe  = (totalSolarUsedMWh > 0) ? (solarAnnualFixedOM / totalSolarUsedMWh) : 0;

  // c) Battery
  // capacity in MWh, cost in GBP/kWh => multiply MWh by 1000
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  // Assume 25-year life for battery
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  // approximate battery MW => MWh/4
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  const batteryLcoe = (totalBatteryDischargeMWh > 0) ? (batteryAnnualCost / totalBatteryDischargeMWh) : 0;
  const batteryCapexLcoe = (totalBatteryDischargeMWh > 0) ? (batteryAnnualCapex / totalBatteryDischargeMWh) : 0;
  const batteryOpexLcoe  = (totalBatteryDischargeMWh > 0) ? (batteryAnnualFixedOM / totalBatteryDischargeMWh) : 0;

  // d) System LCOE => total cost / total load
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

  // === 4) Update Charts
  // We'll show "solarUsed + batteryOut + gasUsed" stacked as the portion that meets load,
  // and "batteryIn" as negative bars to indicate charging.
  updateAnnualMixChart(totalSolarUsedMWh, totalBatteryDischargeMWh, totalGasMWh);
  updateYearlyProfileChart(solarUsed, batteryOut, gasUsed, batteryIn);
  updateJanChart(solarUsed, batteryOut, gasUsed, batteryIn);
  updateJulChart(solarUsed, batteryOut, gasUsed, batteryIn);
  updateLcoeBreakdownChart({
    gasCapex: gasCapexLcoe, gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe, solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe, batteryOpex: batteryOpexLcoe
  });

  // === 5) Summary
  const summaryDiv = document.getElementById("summary");
  summaryDiv.innerHTML = `
    <p><strong>Solar (direct to load):</strong> ${Math.round(totalSolarUsedMWh).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryDischargeMWh).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>Total Load:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
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
  return arr.reduce((acc, val) => acc + val, 0);
}

/** Capital Recovery Factor => annualize lump-sum capex */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** === CHARTING === */

/**
 * 1) Annual Mix Pie (Solar vs. Battery vs. Gas)
 */
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

/**
 * 2) Yearly Profile => stacked bar
 *    solarUsed, batteryOut, gasUsed above 0,
 *    batteryIn (charging) below 0
 */
let yearlyProfileChart;
function updateYearlyProfileChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  const ctx = document.getElementById("yearlyProfileChart").getContext("2d");
  if (yearlyProfileChart) yearlyProfileChart.destroy();

  const labels = [...Array(HOURS_PER_YEAR).keys()];

  yearlyProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Battery In (Charging)",
          data: batteryIn,    // negative => below axis
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Solar (Used)",
          data: solarUsed,
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery Out",
          data: batteryOut,
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasUsed,
          backgroundColor: "#f45d5d",
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
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

/**
 * 3) Jan Chart => first 7 days
 */
let janProfileChart;
function updateJanChart(solarUsed, batteryOut, gasUsed, batteryIn) {
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
          label: "Battery In (Charging)",
          data: batteryIn.slice(janStart, janEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Solar (Used)",
          data: solarUsed.slice(janStart, janEnd),
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery Out",
          data: batteryOut.slice(janStart, janEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasUsed.slice(janStart, janEnd),
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

/**
 * 4) Jul Chart => pick 7 days from ~ end of June
 */
let julProfileChart;
function updateJulChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  const ctx = document.getElementById("julProfileChart").getContext("2d");
  if (julProfileChart) julProfileChart.destroy();

  const julStart = 24 * (31 + 28 + 31 + 30 + 31 + 30); // end of June
  const julEnd = julStart + (24 * 7);
  const labels = [...Array(julEnd - julStart).keys()];

  julProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Battery In (Charging)",
          data: batteryIn.slice(julStart, julEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Solar (Used)",
          data: solarUsed.slice(julStart, julEnd),
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery Out",
          data: batteryOut.slice(julStart, julEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasUsed.slice(julStart, julEnd),
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

/**
 * 5) LCOE Breakdown => bar chart with capex vs. opex
 */
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
          backgroundColor: "#7777ff"
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
