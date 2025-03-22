/***************************************************
 * model.js
 * Chart.js + Zoom
 *  - Single bar for generation mix (100%).
 *  - Single bar for total system LCOE (6 segments).
 *  - Show full solar generation in charts,
 *    but only "usedSolar" in cost calculations.
 ***************************************************/

let solarProfile = [];           // 8760-hour array
const HOURS_PER_YEAR = 8760;

// We'll keep references to each chart so we can destroy them before re-creating
let annualMixChart, yearlyProfileChart, janProfileChart, julProfileChart, lcoeBreakdownChart;

window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: (results) => {
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. Sample 24h:", solarProfile.slice(0,24));
      runModel(); // run default scenario
    }
  });
};

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
  const gasFuel  = parseFloat(document.getElementById("gasFuel").value) || 40;
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value) || 45) / 100;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value) || 8) / 100;
  const waccRenew  = (parseFloat(document.getElementById("waccRenew").value) || 5) / 100;

  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25;
  const lifetimeSolar  = parseFloat(document.getElementById("lifetimeSolar").value) || 35;

  // Convert capacities
  const solarCapMW = solarCapGW * 1000;        // GW -> MW
  const batteryCapMWh = batteryCapGWh * 1000;  // GWh -> MWh

  // === 2) Dispatch Model ===
  // We'll track:
  //  - chartSolarFlow[h]: total clipped solar each hour (for charts)
  //  - usedSolarFlow[h]: only the portion of solar that actually met load (for cost)
  //  - batteryOut[h]: battery discharge meeting load
  //  - batteryIn[h]: negative => charging
  //  - gasFlow[h]: gas meeting load

  let batterySoC = 0;
  const chartSolarFlow = new Array(HOURS_PER_YEAR).fill(0); // total clipped solar for chart
  const usedSolarFlow = new Array(HOURS_PER_YEAR).fill(0);  // only solar used to meet load
  const batteryOut = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryIn = new Array(HOURS_PER_YEAR).fill(0);

  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1 GW => 1000 MWh/h

    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);
    // For charts, store entire clipped solar
    chartSolarFlow[h] = clippedSolarMW;

    // Decide how much solar actually meets load
    const solarToLoad = Math.min(clippedSolarMW, demand);
    usedSolarFlow[h] = solarToLoad;
    demand -= solarToLoad;

    // Surplus leftover
    let leftoverSolar = clippedSolarMW - solarToLoad;

    // Charge battery if leftover
    if (leftoverSolar > 0 && batterySoC < batteryCapMWh) {
      const space = batteryCapMWh - batterySoC;
      const charge = Math.min(leftoverSolar, space);
      batterySoC += charge;
      batteryIn[h] = -charge; // negative => charging
      leftoverSolar -= charge;
    }

    // If there's still demand, discharge battery
    if (demand > 0 && batterySoC > 0) {
      const discharge = Math.min(demand, batterySoC);
      batterySoC -= discharge;
      batteryOut[h] = discharge;
      demand -= discharge;
    }

    // If still demand, use gas
    if (demand > 0) {
      gasFlow[h] = demand;
      demand = 0;
    }
  }

  // Summaries
  const totalChartSolarMWh = sumArray(chartSolarFlow);         // for display in charts
  const totalUsedSolarMWh  = sumArray(usedSolarFlow);          // for cost
  const totalBatteryMWh    = sumArray(batteryOut);
  const totalGasMWh        = sumArray(gasFlow);
  const totalDemandMWh     = HOURS_PER_YEAR * 1000; // 8,760,000

  // === 3) LCOE Calculation ===
  // We only use totalUsedSolarMWh for solar cost
  // a) Gas
  const gasCapMW = 1000; // 1 GW
  const gasCapexTotal = gasCapMW * 1000 * gasCapex;
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex  = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  const gasAnnualVarOM   = totalGasMWh * gasVarOM;
  const gasAnnualFuel    = totalGasMWh * gasFuel;
  const gasAnnualCost    = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  // LCOE for gas
  const gasLcoe = (totalGasMWh > 0) ? (gasAnnualCost / totalGasMWh) : 0;
  const gasCapexLcoe = (totalGasMWh > 0) ? (gasAnnualCapex / totalGasMWh) : 0;
  const gasOpexLcoe  = (totalGasMWh > 0)
    ? ((gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalGasMWh)
    : 0;

  // b) Solar
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex  = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  // Only count used solar for LCOE
  const solarLcoe = (totalUsedSolarMWh > 0)
    ? (solarAnnualCost / totalUsedSolarMWh)
    : 0;
  const solarCapexLcoe = (totalUsedSolarMWh > 0)
    ? (solarAnnualCapex / totalUsedSolarMWh)
    : 0;
  const solarOpexLcoe = (totalUsedSolarMWh > 0)
    ? (solarAnnualFixedOM / totalUsedSolarMWh)
    : 0;

  // c) Battery
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25); // 25-year battery
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  const batteryLcoe = (totalBatteryMWh > 0)
    ? (batteryAnnualCost / totalBatteryMWh)
    : 0;
  const batteryCapexLcoe = (totalBatteryMWh > 0)
    ? (batteryAnnualCapex / totalBatteryMWh)
    : 0;
  const batteryOpexLcoe = (totalBatteryMWh > 0)
    ? (batteryAnnualFixedOM / totalBatteryMWh)
    : 0;

  // d) System LCOE => total cost / total demand
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

  // === 4) Charts

  // 4a) Generation Mix (1 bar => 100%)
  // We show share of Gas, Used Solar, Battery Out in the final load.
  // each is portion / totalDemandMWh => *100
  const gasSharePct    = (totalGasMWh / totalDemandMWh) * 100;
  const solarSharePct  = (totalUsedSolarMWh / totalDemandMWh) * 100;
  const batterySharePct= (totalBatteryMWh / totalDemandMWh) * 100;

  updateGenerationMixChart(gasSharePct, solarSharePct, batterySharePct);

  // 4b) Yearly Profile => show total solar (chartSolarFlow), batteryIn, batteryOut, gasFlow
  updateYearlyProfileChart(chartSolarFlow, batteryIn, batteryOut, gasFlow);

  // 4c) January
  updateJanChart(chartSolarFlow, batteryIn, batteryOut, gasFlow);

  // 4d) July
  updateJulChart(chartSolarFlow, batteryIn, batteryOut, gasFlow);

  // 4e) LCOE Breakdown => single bar with 6 stacked segments
  updateLcoeBreakdownChart({
    gasCapex: gasCapexLcoe,
    gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe,
    solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe,
    batteryOpex: batteryOpexLcoe,
    systemLcoe
  });

  // 5) Summary
  document.getElementById("summary").innerHTML = `
    <p><strong>Total Solar (Generated):</strong> ${Math.round(totalChartSolarMWh).toLocaleString()} MWh</p>
    <p><strong>Solar Used (for cost):</strong> ${Math.round(totalUsedSolarMWh).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryMWh).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>Total Demand:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
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

// Summation helper
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

// CRF
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** =============== CHARTS =============== **/

/**
 * 1) Generation Mix => single stacked bar from 0..100%
 *    Gas, Solar, Battery
 */
function updateGenerationMixChart(gasPct, solarPct, batteryPct) {
  if (annualMixChart) annualMixChart.destroy();
  const ctx = document.getElementById("annualMixChart").getContext("2d");

  annualMixChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Generation Mix"],
      datasets: [
        {
          label: "Gas",
          data: [gasPct],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-gas'),
          stack: "mix"
        },
        {
          label: "Solar",
          data: [solarPct],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-solar'),
          stack: "mix"
        },
        {
          label: "Battery",
          data: [batteryPct],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery'),
          stack: "mix"
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Single Bar => 100% of Load"
        },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: {
            drag: { enabled: true },
            mode: 'x'
          }
        }
      },
      scales: {
        x: {
          stacked: true
        },
        y: {
          stacked: true,
          max: 100,
          min: 0,
          title: { display: true, text: "%" }
        }
      }
    }
  });
}

/**
 * 2) Yearly Profile => show total solar, batteryIn (neg), batteryOut, gas
 */
function updateYearlyProfileChart(solarFlow, batteryIn, batteryOut, gasFlow) {
  if (yearlyProfileChart) yearlyProfileChart.destroy();
  const ctx = document.getElementById("yearlyProfileChart").getContext("2d");

  const labels = [...Array(HOURS_PER_YEAR).keys()];

  yearlyProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Solar (All Generation)",
          data: solarFlow,
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-solar'),
          stack: "stack"
        },
        {
          label: "Battery In (Charging)",
          data: batteryIn,
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery'),
          stack: "stack"
        },
        {
          label: "Battery Out",
          data: batteryOut,
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery-light'),
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasFlow,
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-gas'),
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        title: {
          display: true,
          text: "Yearly Profile (8760 hours)"
        },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: {
            drag: { enabled: true },
            mode: 'x'
          }
        }
      },
      scales: {
        x: { stacked: true, title: { display: true, text: "Hour of Year" } },
        y: { stacked: true, title: { display: true, text: "MWh/h" } }
      }
    }
  });
}

/**
 * 3) January => first 7 days
 */
function updateJanChart(solarFlow, batteryIn, batteryOut, gasFlow) {
  if (janProfileChart) janProfileChart.destroy();
  const ctx = document.getElementById("janProfileChart").getContext("2d");

  const janStart = 0;
  const janEnd = 24*7;
  const labels = [...Array(janEnd - janStart).keys()];

  janProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Solar (All Generation)",
          data: solarFlow.slice(janStart, janEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-solar'),
          stack: "stack"
        },
        {
          label: "Battery In (Charging)",
          data: batteryIn.slice(janStart, janEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery'),
          stack: "stack"
        },
        {
          label: "Battery Out",
          data: batteryOut.slice(janStart, janEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery-light'),
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasFlow.slice(janStart, janEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-gas'),
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Selected January Days"
        },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: {
            drag: { enabled: true },
            mode: 'x'
          }
        }
      },
      scales: {
        x: { stacked: true, title: { display: true, text: "Hour of January" } },
        y: { stacked: true, title: { display: true, text: "MWh/h" } }
      }
    }
  });
}

/**
 * 4) July => 7 days from end of June
 */
function updateJulChart(solarFlow, batteryIn, batteryOut, gasFlow) {
  if (julProfileChart) julProfileChart.destroy();
  const ctx = document.getElementById("julProfileChart").getContext("2d");

  const julStart = 24*(31+28+31+30+31+30);
  const julEnd = julStart + (24*7);
  const labels = [...Array(julEnd - julStart).keys()];

  julProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Solar (All Generation)",
          data: solarFlow.slice(julStart, julEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-solar'),
          stack: "stack"
        },
        {
          label: "Battery In (Charging)",
          data: batteryIn.slice(julStart, julEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery'),
          stack: "stack"
        },
        {
          label: "Battery Out",
          data: batteryOut.slice(julStart, julEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery-light'),
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasFlow.slice(julStart, julEnd),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-gas'),
          stack: "stack"
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Selected July Days"
        },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: {
            drag: { enabled: true },
            mode: 'x'
          }
        }
      },
      scales: {
        x: { stacked: true, title: { display: true, text: "Hour of July" } },
        y: { stacked: true, title: { display: true, text: "MWh/h" } }
      }
    }
  });
}

/**
 * 5) LCOE Breakdown => single bar => sum = total system LCOE
 *    6 segments: gasCapex, gasOpex, solarCapex, solarOpex, batteryCapex, batteryOpex
 */
function updateLcoeBreakdownChart(vals) {
  if (lcoeBreakdownChart) lcoeBreakdownChart.destroy();
  const ctx = document.getElementById("lcoeBreakdownChart").getContext("2d");

  const {
    gasCapex, gasOpex,
    solarCapex, solarOpex,
    batteryCapex, batteryOpex,
    systemLcoe
  } = vals;

  // We'll create 6 stacked segments in a single bar
  lcoeBreakdownChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["System LCOE"],
      datasets: [
        {
          label: "Gas CapEx",
          data: [gasCapex],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-gas'),
          stack: "lcoe"
        },
        {
          label: "Gas OpEx",
          data: [gasOpex],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-gas-light'),
          stack: "lcoe"
        },
        {
          label: "Solar CapEx",
          data: [solarCapex],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-solar'),
          stack: "lcoe"
        },
        {
          label: "Solar OpEx",
          data: [solarOpex],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-solar-light'),
          stack: "lcoe"
        },
        {
          label: "Battery CapEx",
          data: [batteryCapex],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery'),
          stack: "lcoe"
        },
        {
          label: "Battery OpEx",
          data: [batteryOpex],
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-battery-light'),
          stack: "lcoe"
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: `Total System LCOE = ~${systemLcoe.toFixed(2)} GBP/MWh`
        },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: {
            drag: { enabled: true },
            mode: 'x'
          }
        }
      },
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
