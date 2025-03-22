/***************************************************
 * model.js
 * Chart.js with zoom plugin
 * No double-counting solar => only solarUsed is solar
 ***************************************************/

// We'll store the 8760-hour solar profile here
let solarProfile = [];
const HOURS_PER_YEAR = 8760;

// Parse the CSV on load
window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: (results) => {
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. First 24h:", solarProfile.slice(0, 24));
      // Run model once data is loaded
      runModel();
    }
  });
};

/**
 * Main function triggered by "Run Model" button
 */
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

  // Convert capacities
  const solarCapMW = solarCapGW * 1000;        // GW -> MW
  const batteryCapMWh = batteryCapGWh * 1000;  // GWh -> MWh

  // 2) Dispatch Model
  let batterySoC = 0;
  const solarUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryOut = new Array(HOURS_PER_YEAR).fill(0);
  const gasUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryIn = new Array(HOURS_PER_YEAR).fill(0); // negative => charging

  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // 1 GW => 1000 MWh/h

    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // Use solar
    const solarToLoad = Math.min(clippedSolarMW, demand);
    solarUsed[h] = solarToLoad;
    demand -= solarToLoad;

    // Surplus solar leftover
    let leftoverSolar = clippedSolarMW - solarToLoad;

    // Charge battery if leftover
    if (leftoverSolar > 0 && batterySoC < batteryCapMWh) {
      const space = batteryCapMWh - batterySoC;
      const charge = Math.min(leftoverSolar, space);
      batterySoC += charge;
      batteryIn[h] = -charge; // negative => charging
      leftoverSolar -= charge;
    }

    // If still demand, discharge battery
    if (demand > 0 && batterySoC > 0) {
      const discharge = Math.min(demand, batterySoC);
      batterySoC -= discharge;
      batteryOut[h] = discharge;
      demand -= discharge;
    }

    // If still demand, use gas
    if (demand > 0) {
      gasUsed[h] = demand;
      demand = 0;
    }
  }

  // Summaries
  const totalSolarUsedMWh = sumArray(solarUsed);
  const totalBatteryDischargeMWh = sumArray(batteryOut);
  const totalGasMWh = sumArray(gasUsed);
  const totalDemandMWh = HOURS_PER_YEAR * 1000; // 8,760,000

  // 3) LCOE
  // a) Gas
  const gasCapMW = 1000; // 1 GW
  // Gas capex in GBP/kW => multiply by 1000
  const gasCapexTotal = gasCapMW * 1000 * gasCapex;
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasAnnualFuel = totalGasMWh * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  const gasLcoe = (totalGasMWh > 0) ? gasAnnualCost / totalGasMWh : 0;
  const gasCapexLcoe = (totalGasMWh > 0) ? gasAnnualCapex / totalGasMWh : 0;
  const gasOpexLcoe  = (totalGasMWh > 0)
    ? ((gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalGasMWh)
    : 0;

  // b) Solar
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  const solarLcoe = (totalSolarUsedMWh > 0) ? (solarAnnualCost / totalSolarUsedMWh) : 0;
  const solarCapexLcoe = (totalSolarUsedMWh > 0)
    ? (solarAnnualCapex / totalSolarUsedMWh)
    : 0;
  const solarOpexLcoe  = (totalSolarUsedMWh > 0)
    ? (solarAnnualFixedOM / totalSolarUsedMWh)
    : 0;

  // c) Battery
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25); // 25-year assumption
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  const batteryLcoe = (totalBatteryDischargeMWh > 0)
    ? (batteryAnnualCost / totalBatteryDischargeMWh)
    : 0;
  const batteryCapexLcoe = (totalBatteryDischargeMWh > 0)
    ? (batteryAnnualCapex / totalBatteryDischargeMWh)
    : 0;
  const batteryOpexLcoe  = (totalBatteryDischargeMWh > 0)
    ? (batteryAnnualFixedOM / totalBatteryDischargeMWh)
    : 0;

  // d) System LCOE
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

  // 4) Update Charts
  updateAnnualMixChart(totalSolarUsedMWh, totalBatteryDischargeMWh, totalGasMWh);
  updateYearlyProfileChart(solarUsed, batteryOut, gasUsed, batteryIn);
  updateJanChart(solarUsed, batteryOut, gasUsed, batteryIn);
  updateJulChart(solarUsed, batteryOut, gasUsed, batteryIn);
  updateLcoeBreakdownChart({
    gasCapex: gasCapexLcoe,
    gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe,
    solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe,
    batteryOpex: batteryOpexLcoe
  });

  // 5) Summary
  const summaryDiv = document.getElementById("summary");
  summaryDiv.innerHTML = `
    <p><strong>Solar Used:</strong> ${Math.round(totalSolarUsedMWh).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryDischargeMWh).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>Total Demand:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
    <p><strong>System LCOE:</strong> ${systemLcoe.toFixed(2)} GBP/MWh</p>
    <p><em>
      Gas LCOE: ${gasLcoe.toFixed(2)}, 
      Solar LCOE: ${solarLcoe.toFixed(2)}, 
      Battery LCOE: ${batteryLcoe.toFixed(2)}
    </em></p>
  `;
}

/** Helper: sum array */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/** CRF => annualize capital cost */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** === Chart variables so we can destroy before re-creating === */
let annualMixChart, yearlyProfileChart, janProfileChart, julProfileChart, lcoeBreakdownChart;

/**
 * 1) Annual Mix => Horizontal Bar
 */
function updateAnnualMixChart(solarMWh, batteryMWh, gasMWh) {
  if (annualMixChart) annualMixChart.destroy();
  const ctx = document.getElementById("annualMixChart").getContext("2d");

  const data = {
    labels: ["Solar", "Battery", "Gas"],
    datasets: [{
      label: "MWh",
      data: [solarMWh, batteryMWh, gasMWh],
      backgroundColor: ["#f4d44d", "#4db6e4", "#f45d5d"]
    }]
  };
  annualMixChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      indexAxis: 'y', // horizontal bar
      plugins: {
        title: {
          display: true,
          text: "Annual Generation Mix (MWh)"
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'y'
          },
          zoom: {
            drag: {
              enabled: true
            },
            mode: 'y'
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: "MWh" },
          ticks: {
            callback: val => Math.round(val).toLocaleString()
          }
        },
        y: {
          title: { display: true, text: "Source" }
        }
      }
    }
  });
}

/**
 * 2) Yearly Profile => stacked bar
 */
function updateYearlyProfileChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  if (yearlyProfileChart) yearlyProfileChart.destroy();
  const ctx = document.getElementById("yearlyProfileChart").getContext("2d");

  const labels = [...Array(HOURS_PER_YEAR).keys()];
  const data = {
    labels,
    datasets: [
      {
        label: "Battery In (Charging)",
        data: batteryIn,
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
  };
  yearlyProfileChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      responsive: true,
      animation: false,
      plugins: {
        title: {
          display: true,
          text: "Yearly Profile (8760 hours)"
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x'
          },
          zoom: {
            drag: {
              enabled: true
            },
            mode: 'x'
          }
        }
      },
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

/**
 * 3) January => first 7 days
 */
function updateJanChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  if (janProfileChart) janProfileChart.destroy();
  const ctx = document.getElementById("janProfileChart").getContext("2d");

  const janStart = 0;
  const janEnd = 24 * 7;
  const labels = [...Array(janEnd - janStart).keys()];
  const data = {
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
  };
  janProfileChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Selected January Days"
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x'
          },
          zoom: {
            drag: {
              enabled: true
            },
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
function updateJulChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  if (julProfileChart) julProfileChart.destroy();
  const ctx = document.getElementById("julProfileChart").getContext("2d");

  const julStart = 24*(31+28+31+30+31+30);
  const julEnd = julStart + (24*7);
  const labels = [...Array(julEnd - julStart).keys()];
  const data = {
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
  };
  julProfileChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Selected July Days"
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x'
          },
          zoom: {
            drag: {
              enabled: true
            },
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
 * 5) LCOE Breakdown => stacked bar (capex vs opex)
 */
function updateLcoeBreakdownChart(vals) {
  if (lcoeBreakdownChart) lcoeBreakdownChart.destroy();
  const ctx = document.getElementById("lcoeBreakdownChart").getContext("2d");

  const { 
    gasCapex, gasOpex,
    solarCapex, solarOpex,
    batteryCapex, batteryOpex
  } = vals;

  const data = {
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
  };

  lcoeBreakdownChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Levelized Cost Breakdown"
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x'
          },
          zoom: {
            drag: {
              enabled: true
            },
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

