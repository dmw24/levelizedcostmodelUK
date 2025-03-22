/***************************************************
 * model.js
 ***************************************************/

// Global data store for the solar profile
let solarProfile = []; // array of hourly values (0-1 kW/kW capacity)
const HOURS_PER_YEAR = 8760;

window.onload = () => {
  // Parse the CSV right when the page loads
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: function(results) {
      // Extract the "electricity" column as array
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded:", solarProfile.slice(0, 24));
    }
  });
};

/**
 * Main function to run the LCOE model.
 */
function runModel() {
  // === 1) Read user inputs ===
  const solarCapGW = parseFloat(document.getElementById("solarCap").value) || 0;
  const batteryCapGWh = parseFloat(document.getElementById("batteryCap").value) || 0;

  // Assumptions
  const gasCapex = parseFloat(document.getElementById("gasCapex").value) || 800;       // GBP/kW
  const solarCapex = parseFloat(document.getElementById("solarCapex").value) || 450;   // GBP/kW
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200; // GBP/kWh

  const gasFixedOM = parseFloat(document.getElementById("gasFixedOM").value) || 18000; // GBP/MW/yr
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM = parseFloat(document.getElementById("batteryFixedOM").value) || 6000;

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   // GBP/MWh
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 40;    // GBP/MWh
  const gasEfficiency = parseFloat(document.getElementById("gasEfficiency").value) / 100 || 0.45;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = parseFloat(document.getElementById("waccFossil").value) / 100 || 0.08;
  const waccRenew = parseFloat(document.getElementById("waccRenew").value) / 100 || 0.05;

  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value) || 35;

  // Convert to consistent units
  const solarCapMW = solarCapGW * 1000;      // from GW to MW
  const batteryCapMWh = batteryCapGWh * 1000; // from GWh to MWh

  // === 2) Dispatch Model ===
  // We'll supply 1 GW baseload. For each hour:
  //   solar generation = profile * solarCapMW (BUT we must apply the inverter ratio)
  //   battery charges from solar if surplus, discharges if short
  //   remainder from gas
  // We'll track total MWh from each source.

  // Battery state-of-charge (MWh)
  let batterySoC = 0;

  // Arrays to store hourly generation (MWh)
  let solarGen = new Array(HOURS_PER_YEAR).fill(0);
  let batteryGen = new Array(HOURS_PER_YEAR).fill(0);
  let gasGen = new Array(HOURS_PER_YEAR).fill(0);

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    // Demand for each hour is 1 GW => 1000 MWh/h
    const demandMWh = 1000;

    // Potential solar (MW) is solarProfile[h] * solarCapMW
    // But invert AC limit with ratio: max AC = solarCapMW / inverterRatio
    const maxSolarAC = solarCapMW / inverterRatio; // MW
    const rawSolarMW = solarProfile[h] * solarCapMW; // MW
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    const solarMWh = clippedSolarMW; // MWh for this hour
    // Surplus or deficit relative to 1 GW demand
    let deficit = demandMWh - solarMWh;
    let batteryUsed = 0;
    let solarExcess = 0;

    // If there's still demand after solar
    if (deficit > 0) {
      // Attempt to discharge battery
      if (batterySoC > 0) {
        // For simplicity, let the battery meet as much deficit as possible
        batteryUsed = Math.min(deficit, batterySoC);
        deficit -= batteryUsed;
        batterySoC -= batteryUsed;
      }
    } else {
      // We have surplus solar
      solarExcess = Math.abs(deficit);
      deficit = 0;

      // Charge battery with surplus
      const spaceInBattery = batteryCapMWh - batterySoC;
      const batteryCharge = Math.min(solarExcess, spaceInBattery);
      batterySoC += batteryCharge;
      solarExcess -= batteryCharge;
    }

    // Any remaining deficit is met by gas
    const gasUsed = deficit > 0 ? deficit : 0;

    // Store results
    solarGen[h] = solarMWh;        // MWh from solar
    batteryGen[h] = batteryUsed;   // MWh from battery
    gasGen[h] = gasUsed;           // MWh from gas
  }

  // === 3) Summaries ===
  const totalSolarMWh = sumArray(solarGen);
  const totalBatteryMWh = sumArray(batteryGen);
  const totalGasMWh = sumArray(gasGen);
  const totalDemandMWh = totalSolarMWh + totalBatteryMWh + totalGasMWh; // should be ~ 8760 * 1000

  // === 4) LCOE Calculation ===
  // We'll do a simplistic approach: we treat each asset's LCOE separately, then do a weighted sum.

  // Gas plant is 1 GW => 1000 MW
  const gasCapMW = 1000; // 1 GW
  const solarCapexTotal = solarCapMW * solarCapex;        // GBP
  const gasCapexTotal = gasCapMW * gasCapex;              // GBP
  // Battery: MWh * capex
  const batteryCapexTotal = batteryCapMWh * batteryCapex; // GBP

  // Convert fixed O&M from GBP/MW/yr to total
  const gasFixedOMTotal = gasCapMW * gasFixedOM;         // GBP/yr
  const solarFixedOMTotal = solarCapMW * solarFixedOM;   // GBP/yr
  // Battery fixed O&M in GBP/MW/yr => need battery power rating? 
  // For simplicity, assume battery power rating = batteryCapMWh / 1 (1hr battery) or user can define
  // We'll approximate battery MW = batteryCapMWh / 4 for example. This is an assumption you can refine.
  // Or treat the "MW" for battery as if batteryCapMWh => "capacity" in MW if 1 hour discharge.
  // Let's do a simple approach: if we had a "battery MW" = batteryCapMWh / 4
  const batteryMW = batteryCapMWh / 4;
  const batteryFixedOMTotal = batteryMW * batteryFixedOM;

  // Fuel cost for gas = gasUsed (MWh) * gasFuel
  // But we also have gasVarOM per MWh
  const totalGasFuelCost = totalGasMWh * gasFuel;
  const totalGasVarOMCost = totalGasMWh * gasVarOM;

  // Capital Recovery Factors
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  // For battery, assume same lifetime as solar for simplicity
  const crfBattery = calcCRF(waccRenew, lifetimeSolar);

  // Annualized CAPEX
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;

  // Summarize each asset's annual cost
  // Gas
  const gasAnnualCost = gasAnnualCapex + gasFixedOMTotal + totalGasFuelCost + totalGasVarOMCost;
  // Solar
  const solarAnnualCost = solarAnnualCapex + solarFixedOMTotal;
  // Battery
  const batteryAnnualCost = batteryAnnualCapex + batteryFixedOMTotal;

  // LCOE for each (GBP/MWh)
  // We'll divide each by the total MWh that asset actually produced or contributed
  // For gas, that's totalGasMWh
  // For solar, totalSolarMWh
  // For battery, totalBatteryMWh (though battery cycles come from solar, but let's keep it simple)
  const gasLcoe = totalGasMWh > 0 ? gasAnnualCost / (totalGasMWh / HOURS_PER_YEAR) : 0;
  const solarLcoe = totalSolarMWh > 0 ? solarAnnualCost / (totalSolarMWh / HOURS_PER_YEAR) : 0;
  const batteryLcoe = totalBatteryMWh > 0 ? batteryAnnualCost / (totalBatteryMWh / HOURS_PER_YEAR) : 0;

  // Weighted total LCOE => (Total annual cost) / (Total MWh / 8760)
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / ( (totalDemandMWh / HOURS_PER_YEAR) );

  // === 5) Update Charts and Output ===
  updateAnnualMixChart(totalSolarMWh, totalBatteryMWh, totalGasMWh);
  updateYearlyProfileChart(solarGen, batteryGen, gasGen);
  updateJanChart(solarGen, batteryGen, gasGen);
  updateJulChart(solarGen, batteryGen, gasGen);
  updateLcoeBreakdownChart(gasLcoe, solarLcoe, batteryLcoe, systemLcoe);

  // Fill summary text
  const summaryDiv = document.getElementById("summary");
  summaryDiv.innerHTML = `
    <p><strong>Total Generation:</strong> ${Math.round(totalDemandMWh).toLocaleString()} MWh</p>
    <p><strong>Solar Generation:</strong> ${Math.round(totalSolarMWh).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryMWh).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
    <p><strong>System LCOE:</strong> ${systemLcoe.toFixed(2)} GBP/MWh</p>
    <p><em>(Gas LCOE: ${gasLcoe.toFixed(2)}, Solar LCOE: ${solarLcoe.toFixed(2)}, Battery LCOE: ${batteryLcoe.toFixed(2)})</em></p>
  `;
}

/**
 * Helper: Summation of array
 */
function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/**
 * Capital Recovery Factor
 */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/**
 * Update Annual Mix Chart
 */
let annualMixChart;
function updateAnnualMixChart(solarMWh, batteryMWh, gasMWh) {
  const total = solarMWh + batteryMWh + gasMWh;
  const solarPct = (solarMWh / total) * 100;
  const batteryPct = (batteryMWh / total) * 100;
  const gasPct = (gasMWh / total) * 100;

  const ctx = document.getElementById("annualMixChart").getContext("2d");
  if (annualMixChart) annualMixChart.destroy();
  annualMixChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: ["Solar", "Battery", "Gas"],
      datasets: [{
        data: [solarPct, batteryPct, gasPct],
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
 * Update Yearly Profile Chart (stacked area or bar)
 */
let yearlyProfileChart;
function updateYearlyProfileChart(solarGen, batteryGen, gasGen) {
  const ctx = document.getElementById("yearlyProfileChart").getContext("2d");
  if (yearlyProfileChart) yearlyProfileChart.destroy();

  yearlyProfileChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [...Array(HOURS_PER_YEAR).keys()], // 0..8759
      datasets: [
        {
          label: "Solar",
          data: solarGen,
          borderColor: "#f4d44d",
          backgroundColor: "#f4d44d",
          fill: true
        },
        {
          label: "Battery",
          data: batteryGen,
          borderColor: "#4db6e4",
          backgroundColor: "#4db6e4",
          fill: true
        },
        {
          label: "Gas",
          data: gasGen,
          borderColor: "#f45d5d",
          backgroundColor: "#f45d5d",
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: {
          display: true,
          title: { display: true, text: "Hour of Year" }
        },
        y: {
          display: true,
          title: { display: true, text: "Generation (MWh/h)" }
        }
      }
    }
  });
}

/**
 * Update January Profile Chart
 * Let's look at hours 0..168 (first week of Jan)
 */
let janProfileChart;
function updateJanChart(solarGen, batteryGen, gasGen) {
  const ctx = document.getElementById("janProfileChart").getContext("2d");
  if (janProfileChart) janProfileChart.destroy();

  const janStart = 0;
  const janEnd = 24 * 7; // first 7 days
  const labels = [...Array(janEnd - janStart).keys()];

  janProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Solar",
          data: solarGen.slice(janStart, janEnd),
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery",
          data: batteryGen.slice(janStart, janEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasGen.slice(janStart, janEnd),
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

/**
 * Update July Profile Chart
 * Let's look at ~ mid-July: hour 24*31*6=4464 to 4464+168 for a random example
 * (Simplified approach)
 */
let julProfileChart;
function updateJulChart(solarGen, batteryGen, gasGen) {
  const ctx = document.getElementById("julProfileChart").getContext("2d");
  if (julProfileChart) julProfileChart.destroy();

  const julStart = 24 * (31 + 28 + 31 + 30 + 31 + 30); // end of June
  const julEnd = julStart + (24 * 7);
  const labels = [...Array(julEnd - julStart).keys()];

  julProfileChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Solar",
          data: solarGen.slice(julStart, julEnd),
          backgroundColor: "#f4d44d",
          stack: "stack"
        },
        {
          label: "Battery",
          data: batteryGen.slice(julStart, julEnd),
          backgroundColor: "#4db6e4",
          stack: "stack"
        },
        {
          label: "Gas",
          data: gasGen.slice(julStart, julEnd),
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

/**
 * Update LCOE Breakdown Chart
 */
let lcoeBreakdownChart;
function updateLcoeBreakdownChart(gasLcoe, solarLcoe, batteryLcoe, systemLcoe) {
  const ctx = document.getElementById("lcoeBreakdownChart").getContext("2d");
  if (lcoeBreakdownChart) lcoeBreakdownChart.destroy();

  lcoeBreakdownChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Gas", "Solar", "Battery", "System Avg"],
      datasets: [{
        label: "GBP/MWh",
        data: [gasLcoe, solarLcoe, batteryLcoe, systemLcoe],
        backgroundColor: ["#f45d5d", "#f4d44d", "#4db6e4", "#888"]
      }]
    },
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "GBP/MWh" }
        }
      }
    }
  });
}
