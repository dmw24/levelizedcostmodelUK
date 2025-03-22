/***************************************************
 * model.js
 ***************************************************/

// We store the solar profile (8760 hours) in this array
let solarProfile = [];
const HOURS_PER_YEAR = 8760;

// Load CSV immediately on page load
window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: function(results) {
      // Fill solarProfile with hourly capacity factors
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. First 24 hours:", solarProfile.slice(0,24));

      // Once loaded, run model with default inputs
      runModel();
    }
  });
};

function runModel() {
  // === 1) Grab user inputs ===
  const solarCapGW = parseFloat(document.getElementById("solarCap").value) || 0;
  const batteryCapGWh = parseFloat(document.getElementById("batteryCap").value) || 0;

  // Cost assumptions
  const gasCapex = parseFloat(document.getElementById("gasCapex").value) || 800;       // GBP/kW
  const solarCapex = parseFloat(document.getElementById("solarCapex").value) || 450;   // GBP/kW
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200; // GBP/kWh

  const gasFixedOM = parseFloat(document.getElementById("gasFixedOM").value) || 18000; // GBP/MW/yr
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM = parseFloat(document.getElementById("batteryFixedOM").value) || 6000;

  const gasVarOM = parseFloat(document.getElementById("gasVarOM").value) || 4;   // GBP/MWh
  const gasFuel = parseFloat(document.getElementById("gasFuel").value) || 40;    // GBP/MWh
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value) || 45) / 100;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value) || 1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value) || 8) / 100;
  const waccRenew = (parseFloat(document.getElementById("waccRenew").value) || 5) / 100;

  const lifetimeFossil = parseFloat(document.getElementById("lifetimeFossil").value) || 25; // e.g. 25 yrs
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value) || 35;   // e.g. 35 yrs

  // Convert to MW, MWh
  const solarCapMW = solarCapGW * 1000;
  const batteryCapMWh = batteryCapGWh * 1000;

  // === 2) Dispatch model ===
  // We'll meet 1 GW baseload => 1000 MWh/h
  let batterySoC = 0;
  const solarFlow = new Array(HOURS_PER_YEAR).fill(0);
  const batteryFlow = new Array(HOURS_PER_YEAR).fill(0);
  const gasFlow = new Array(HOURS_PER_YEAR).fill(0);

  // Max AC from solar after inverter ratio
  const maxSolarAC = solarCapMW / inverterRatio;

  for (let h = 0; h < HOURS_PER_YEAR; h++) {
    let demand = 1000; // MWh/h
    // Potential solar
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);
    solarFlow[h] = clippedSolarMW;

    // Net load after solar
    let netLoad = demand - clippedSolarMW; 

    if (netLoad > 0) {
      // We still need power => try discharging battery
      if (batterySoC > 0) {
        const discharge = Math.min(netLoad, batterySoC);
        batteryFlow[h] = discharge; // + => discharge
        batterySoC -= discharge;
        netLoad -= discharge;
      }
      // Remaining netLoad from gas
      if (netLoad > 0) {
        gasFlow[h] = netLoad;
        netLoad = 0;
      }
    } else {
      // We have surplus solar => charge battery
      const surplus = -netLoad; 
      const spaceInBattery = batteryCapMWh - batterySoC;
      if (spaceInBattery > 0) {
        const charge = Math.min(surplus, spaceInBattery);
        batterySoC += charge;
        batteryFlow[h] = -charge; // negative => charging
      }
      // netLoad is zero now
    }
  }

  // === 3) Summaries ===
  const totalSolarMWh = sumArray(solarFlow);
  const totalBatteryDischargeMWh = sumArray(batteryFlow.map(x => (x > 0 ? x : 0)));
  const totalGasMWh = sumArray(gasFlow);
  // The total demand is 8760 * 1000 = 8,760,000 MWh
  const totalDemandMWh = HOURS_PER_YEAR * 1000;

  // === 4) LCOE with separate lifetimes ===

  // a) Gas => uses lifetimeFossil
  const gasCapMW = 1000; // 1 GW
  const gasCapexTotal = gasCapMW * gasCapex; // GBP
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  // O&M
  const gasAnnualFixedOM = gasCapMW * gasFixedOM; 
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasAnnualFuel = totalGasMWh * gasFuel;
  const gasAnnualCost = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  const gasLcoe = (totalGasMWh > 0)
    ? gasAnnualCost / (totalGasMWh / HOURS_PER_YEAR)
    : 0;
  const gasCapexLcoe = (totalGasMWh > 0)
    ? gasAnnualCapex / (totalGasMWh / HOURS_PER_YEAR)
    : 0;
  const gasOpexLcoe = (totalGasMWh > 0)
    ? (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / (totalGasMWh / HOURS_PER_YEAR)
    : 0;

  // b) Solar => uses lifetimeSolar
  const solarCapexTotal = solarCapMW * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM = solarCapMW * solarFixedOM;
  const solarAnnualCost = solarAnnualCapex + solarAnnualFixedOM;
  const solarLcoe = (totalSolarMWh > 0)
    ? solarAnnualCost / (totalSolarMWh / HOURS_PER_YEAR)
    : 0;
  const solarCapexLcoe = (totalSolarMWh > 0)
    ? solarAnnualCapex / (totalSolarMWh / HOURS_PER_YEAR)
    : 0;
  const solarOpexLcoe = (totalSolarMWh > 0)
    ? solarAnnualFixedOM / (totalSolarMWh / HOURS_PER_YEAR)
    : 0;

  // c) Battery => hard-coded 25 years
  const batteryCapexTotal = batteryCapMWh * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  // For O&M, we guess battery power rating => batteryCapMWh / 4, etc.
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;
  const batteryLcoe = (totalBatteryDischargeMWh > 0)
    ? batteryAnnualCost / (totalBatteryDischargeMWh / HOURS_PER_YEAR)
    : 0;
  const batteryCapexLcoe = (totalBatteryDischargeMWh > 0)
    ? batteryAnnualCapex / (totalBatteryDischargeMWh / HOURS_PER_YEAR)
    : 0;
  const batteryOpexLcoe = (totalBatteryDischargeMWh > 0)
    ? batteryAnnualFixedOM / (totalBatteryDischargeMWh / HOURS_PER_YEAR)
    : 0;

  // d) System LCOE => sum of each tech's "annual cost" / total load
  //    This means we add them up as if each has its own annual cost from its CRF.
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / ( (totalDemandMWh / HOURS_PER_YEAR) );

  // === 5) Update Charts and Output ===
  updateAnnualMixChart(totalSolarMWh, totalBatteryDischargeMWh, totalGasMWh);
  updateYearlyProfileChart(solarFlow, batteryFlow, gasFlow);
  updateJanChart(solarFlow, batteryFlow, gasFlow);
  updateJulChart(solarFlow, batteryFlow, gasFlow);
  updateLcoeBreakdownChart({
    gasCapex: gasCapexLcoe, gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe, solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe, batteryOpex: batteryOpexLcoe
  });

  // Summary
  const summaryDiv = document.getElementById("summary");
  summaryDiv.innerHTML = `
    <p><strong>Total Demand Met:</strong> ${totalDemandMWh.toLocaleString()} MWh</p>
    <p><strong>Solar Generation:</strong> ${Math.round(totalSolarMWh).toLocaleString()} MWh</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryDischargeMWh).toLocaleString()} MWh</p>
    <p><strong>Gas Generation:</strong> ${Math.round(totalGasMWh).toLocaleString()} MWh</p>
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
  return arr.reduce((a,b) => a + b, 0);
}

/** Capital Recovery Factor */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** === Charting === */

// 1) Annual Mix
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

// 2) Yearly Profile
let yearlyProfileChart;
function updateYearlyProfileChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("yearlyProfileChart").getContext("2d");
  if (yearlyProfileChart) yearlyProfileChart.destroy();

  yearlyProfileChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [...Array(HOURS_PER_YEAR).keys()],
      datasets: [
        {
          label: "Solar (MWh/h)",
          data: solarFlow,
          borderColor: "#f4d44d",
          backgroundColor: "#f4d44d22",
          fill: false
        },
        {
          label: "Battery (MWh/h) (+ = discharge, - = charge)",
          data: batteryFlow,
          borderColor: "#4db6e4",
          backgroundColor: "#4db6e422",
          fill: false
        },
        {
          label: "Gas (MWh/h)",
          data: gasFlow,
          borderColor: "#f45d5d",
          backgroundColor: "#f45d5d22",
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: { display: true, text: "Hour of Year" }
        },
        y: {
          title: { display: true, text: "Power (MWh/h)" }
        }
      }
    }
  });
}

// 3) January
let janProfileChart;
function updateJanChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("janProfileChart").getContext("2d");
  if (janProfileChart) janProfileChart.destroy();

  const janStart = 0;
  const janEnd = 24*7; // first 7 days
  const labels = [...Array(janEnd - janStart).keys()];

  janProfileChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Solar (MWh/h)",
          data: solarFlow.slice(janStart, janEnd),
          borderColor: "#f4d44d",
          fill: false
        },
        {
          label: "Battery (MWh/h)",
          data: batteryFlow.slice(janStart, janEnd),
          borderColor: "#4db6e4",
          fill: false
        },
        {
          label: "Gas (MWh/h)",
          data: gasFlow.slice(janStart, janEnd),
          borderColor: "#f45d5d",
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "Power (MWh/h)" } },
        x: { title: { display: true, text: "Hour of January" } }
      }
    }
  });
}

// 4) July
let julProfileChart;
function updateJulChart(solarFlow, batteryFlow, gasFlow) {
  const ctx = document.getElementById("julProfileChart").getContext("2d");
  if (julProfileChart) julProfileChart.destroy();

  const julStart = 24*(31+28+31+30+31+30); // end of June
  const julEnd = julStart + 24*7;
  const labels = [...Array(julEnd - julStart).keys()];

  julProfileChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Solar (MWh/h)",
          data: solarFlow.slice(julStart, julEnd),
          borderColor: "#f4d44d",
          fill: false
        },
        {
          label: "Battery (MWh/h)",
          data: batteryFlow.slice(julStart, julEnd),
          borderColor: "#4db6e4",
          fill: false
        },
        {
          label: "Gas (MWh/h)",
          data: gasFlow.slice(julStart, julEnd),
          borderColor: "#f45d5d",
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "Power (MWh/h)" } },
        x: { title: { display: true, text: "Hour of July" } }
      }
    }
  });
}

// 5) LCOE Breakdown (stacked bar: Capex vs Opex for Gas, Solar, Battery)
let lcoeBreakdownChart;
function updateLcoeBreakdownChart(values) {
  const { 
    gasCapex, gasOpex,
    solarCapex, solarOpex,
    batteryCapex, batteryOpex
  } = values;

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
