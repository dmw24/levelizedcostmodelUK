/***************************************************
 * model.js
 * 
 * - Gas capacity fixed at 1 GW
 * - Clamps user inputs to min(0.0001)
 * - Dispatch model to supply 1 GW baseload
 * - Final cost chart: 3 bars => "Capex", "Opex", "Total" each stacked by Gas/Solar/Battery
 * - Detailed summary for each tech: discount rate, lifetime, CRF, total capex, annual OPEX
 * - "Total levelized system cost" text below
 ***************************************************/

let solarProfile = [];
const HOURS_PER_YEAR = 8760;

window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: (results) => {
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. First 24h:", solarProfile.slice(0, 24));
      // Run once loaded
      runModel();
    }
  });
};

function runModel() {
  // === 1) Inputs ===
  const gasCapMW = 1000; // 1 GW fixed

  // Parse user inputs, clamp to 0.0001 min
  const solarCapGW = clamp(parseFloat(document.getElementById("solarCap").value) || 0);
  const batteryCapGWh = clamp(parseFloat(document.getElementById("batteryCap").value) || 0);

  const gasCapex = clamp(parseFloat(document.getElementById("gasCapex").value) || 0);
  const solarCapex = clamp(parseFloat(document.getElementById("solarCapex").value) || 0);
  const batteryCapex = clamp(parseFloat(document.getElementById("batteryCapex").value) || 0);

  const gasFixedOM = clamp(parseFloat(document.getElementById("gasFixedOM").value) || 0);
  const solarFixedOM = clamp(parseFloat(document.getElementById("solarFixedOM").value) || 0);
  const batteryFixedOM = clamp(parseFloat(document.getElementById("batteryFixedOM").value) || 0);

  const gasVarOM = clamp(parseFloat(document.getElementById("gasVarOM").value) || 0);
  const gasFuel = clamp(parseFloat(document.getElementById("gasFuel").value) || 0);

  const gasEfficiencyPct = clamp(parseFloat(document.getElementById("gasEfficiency").value) || 0);
  const gasEfficiency = gasEfficiencyPct / 100;

  const inverterRatio = clamp(parseFloat(document.getElementById("inverterRatio").value) || 0);

  const waccFossilPct = clamp(parseFloat(document.getElementById("waccFossil").value) || 0);
  const waccFossil = waccFossilPct / 100;

  const waccRenewPct = clamp(parseFloat(document.getElementById("waccRenew").value) || 0);
  const waccRenew = waccRenewPct / 100;

  const lifetimeFossil = clamp(parseFloat(document.getElementById("lifetimeFossil").value) || 0);
  const lifetimeSolar = clamp(parseFloat(document.getElementById("lifetimeSolar").value) || 0);

  // Convert to MW / MWh
  const solarCapMW = solarCapGW * 1000;
  const batteryCapMWh = batteryCapGWh * 1000;

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
    const rawSolarMW = (solarProfile[h] || 0) * solarCapMW;
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

  const totalDemandMWh = HOURS_PER_YEAR * 1000;

  // === 4) Cost & "Levelized System Cost" ===

  // Gas
  const gasCapexTotal = gasCapMW * 1000 * gasCapex;
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;

  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  // If gasEfficiency is extremely small, it means a huge fuel usage, but we clamp at 0.0001 above
  const gasFuelConsumed = totalGasMWh / gasEfficiency; 
  const gasAnnualFuel = gasFuelConsumed * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;

  // Solar
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;

  // Battery
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;

  // Sum total cost
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const levelizedSystemCost = totalAnnualCost / totalDemandMWh;

  // Break out each technology's capex vs. opex
  const gasCapexLcoe = gasAnnualCapex / totalDemandMWh;
  const gasOpexLcoe  = (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalDemandMWh;

  const solarCapexLcoe = solarAnnualCapex / totalDemandMWh;
  const solarOpexLcoe  = solarAnnualFixedOM / totalDemandMWh;

  const batteryCapexLcoe = batteryAnnualCapex / totalDemandMWh;
  const batteryOpexLcoe  = batteryAnnualFixedOM / totalDemandMWh;

  // Totals
  const gasTotalLcoe = gasCapexLcoe + gasOpexLcoe;
  const solarTotalLcoe = solarCapexLcoe + solarOpexLcoe;
  const batteryTotalLcoe = batteryCapexLcoe + batteryOpexLcoe;
  const systemTotal = gasTotalLcoe + solarTotalLcoe + batteryTotalLcoe;

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

  // Final stacked bar with 3 bars: "Capex", "Opex", "Total"
  updateSystemCostChart({
    gasCapex: gasCapexLcoe,
    gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe,
    solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe,
    batteryOpex: batteryOpexLcoe
  });

  // Show text below chart
  const resultDiv = document.getElementById("levelizedCostResult");
  resultDiv.innerHTML = `
    <p>Total levelized system cost: ${systemTotal.toFixed(2)} GBP/MWh</p>
    <hr/>
    <p><strong>Gas:</strong></p>
    <ul>
      <li>Discount rate: ${(waccFossil*100).toFixed(2)}% | Lifetime: ${lifetimeFossil} yrs | CRF: ${crfGas.toFixed(4)}</li>
      <li>Total Capex: ${Math.round(gasCapexTotal).toLocaleString()} GBP</li>
      <li>Annual Opex: ${(gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel).toLocaleString()} GBP/yr</li>
    </ul>
    <p><strong>Solar:</strong></p>
    <ul>
      <li>Discount rate: ${(waccRenew*100).toFixed(2)}% | Lifetime: ${lifetimeSolar} yrs | CRF: ${crfSolar.toFixed(4)}</li>
      <li>Total Capex: ${Math.round(solarCapexTotal).toLocaleString()} GBP</li>
      <li>Annual Opex: ${Math.round(solarAnnualFixedOM).toLocaleString()} GBP/yr</li>
    </ul>
    <p><strong>Battery:</strong></p>
    <ul>
      <li>Discount rate: ${(waccRenew*100).toFixed(2)}% | Lifetime: 25 yrs | CRF: ${crfBattery.toFixed(4)}</li>
      <li>Total Capex: ${Math.round(batteryCapexTotal).toLocaleString()} GBP</li>
      <li>Annual Opex: ${Math.round(batteryAnnualFixedOM).toLocaleString()} GBP/yr</li>
    </ul>
  `;
}

/** Helper to clamp user inputs to 0.0001 if 0 or negative */
function clamp(val) {
  return Math.max(val, 0.0001);
}

/** Summation */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/** CRF */
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

// 5) Stacked bar for "Capex", "Opex", "Total" splitted by Gas, Solar, Battery
let systemCostChart;
function updateSystemCostChart({
  gasCapex, gasOpex,
  solarCapex, solarOpex,
  batteryCapex, batteryOpex
}) {
  const ctx = document.getElementById("systemCostChart").getContext("2d");
  if (systemCostChart) systemCostChart.destroy();

  systemCostChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Capex", "Opex", "Total"],
      datasets: [
        {
          label: "Gas",
          data: [
            gasCapex, 
            gasOpex,
            gasCapex + gasOpex
          ],
          backgroundColor: "#ff9999",
          stack: "stack"
        },
        {
          label: "Solar",
          data: [
            solarCapex,
            solarOpex,
            solarCapex + solarOpex
          ],
          backgroundColor: "#ffe699",
          stack: "stack"
        },
        {
          label: "Battery",
          data: [
            batteryCapex,
            batteryOpex,
            batteryCapex + batteryOpex
          ],
          backgroundColor: "#99ccff",
          stack: "stack"
        }
      ]
    },
    options: {
      indexAxis: "y", // horizontal
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Levelized System Cost Breakdown"
        },
        legend: { position: "bottom" }
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "GBP/MWh" }
        },
        y: {
          stacked: true,
          title: { display: false }
        }
      }
    }
  });
}

/** 
 * clamp() => ensures no input is below 0.0001 
 */
function clamp(val) {
  return Math.max(val, 0.0001);
}
