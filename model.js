/***************************************************
 * model.js (using Plotly for interactive charts)
 ***************************************************/

// Global solar profile (8760 hours)
let solarProfile = [];
const HOURS_PER_YEAR = 8760;

window.onload = () => {
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: (results) => {
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. Sample:", solarProfile.slice(0, 24));
      runModel();
    }
  });
};

/**
 * Main function triggered by "Run Model" button in your HTML
 */
function runModel() {
  // 1) Gather user inputs
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

  // 2) Unit conversions
  const solarCapMW    = solarCapGW * 1000;        // GW->MW
  const batteryCapMWh = batteryCapGWh * 1000;     // GWh->MWh

  // 3) Dispatch Model
  // We'll track solarUsed, batteryOut, gasUsed, batteryIn
  let batterySoC = 0;
  const solarUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryOut = new Array(HOURS_PER_YEAR).fill(0);
  const gasUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryIn = new Array(HOURS_PER_YEAR).fill(0);

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
  const totalSolarUsedMWh        = sumArray(solarUsed);
  const totalBatteryDischargeMWh = sumArray(batteryOut);
  const totalGasMWh              = sumArray(gasUsed);
  const totalDemandMWh           = HOURS_PER_YEAR * 1000; // 8,760,000

  // 4) LCOE
  // Gas
  const gasCapMW = 1000; // 1 GW
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; // GBP
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas;
  const gasAnnualFixedOM = gasCapMW * gasFixedOM;
  const gasAnnualVarOM = totalGasMWh * gasVarOM;
  const gasAnnualFuel  = totalGasMWh * gasFuel;
  const gasAnnualCost  = gasAnnualCapex + gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel;
  const gasLcoe = (totalGasMWh > 0) ? gasAnnualCost / totalGasMWh : 0;
  const gasCapexLcoe = (totalGasMWh > 0) ? gasAnnualCapex / totalGasMWh : 0;
  const gasOpexLcoe  = (totalGasMWh > 0) 
    ? ( (gasAnnualFixedOM + gasAnnualVarOM + gasAnnualFuel) / totalGasMWh ) 
    : 0;

  // Solar
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

  // Battery
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  const crfBattery = calcCRF(waccRenew, 25); // 25-yr battery
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

  // System LCOE => total cost / total demand
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

  // 5) Render Plotly charts
  plotAnnualMixChart(totalSolarUsedMWh, totalBatteryDischargeMWh, totalGasMWh);
  plotYearlyProfileChart(solarUsed, batteryOut, gasUsed, batteryIn);
  plotJanChart(solarUsed, batteryOut, gasUsed, batteryIn);
  plotJulChart(solarUsed, batteryOut, gasUsed, batteryIn);
  plotLcoeBreakdownChart({
    gasCapex: gasCapexLcoe,
    gasOpex: gasOpexLcoe,
    solarCapex: solarCapexLcoe,
    solarOpex: solarOpexLcoe,
    batteryCapex: batteryCapexLcoe,
    batteryOpex: batteryOpexLcoe
  });

  // 6) Summary
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

/** CRF => annualize capital */
function calcCRF(rate, years) {
  if (rate === 0) return 1 / years;
  const top = rate * Math.pow(1 + rate, years);
  const bot = Math.pow(1 + rate, years) - 1;
  return top / bot;
}

/** ============ Plotly Chart Functions ============ **/

/**
 * 1) Horizontal bar for Annual Mix
 */
function plotAnnualMixChart(solarMWh, batteryMWh, gasMWh) {
  const data = [{
    type: 'bar',
    orientation: 'h',
    x: [solarMWh, batteryMWh, gasMWh],
    y: ['Solar', 'Battery', 'Gas'],
    text: [
      `${Math.round(solarMWh).toLocaleString()} MWh`,
      `${Math.round(batteryMWh).toLocaleString()} MWh`,
      `${Math.round(gasMWh).toLocaleString()} MWh`
    ],
    textposition: 'auto',
    marker: { color: ['#f4d44d', '#4db6e4', '#f45d5d'] }
  }];

  const layout = {
    title: 'Annual Generation Mix',
    xaxis: { title: 'MWh' },
    yaxis: { title: '' },
    dragmode: 'zoom'
  };

  Plotly.newPlot('annualMixChart', data, layout, {scrollZoom: true});
}

/**
 * 2) Yearly Profile => stacked bars
 * We'll make 4 traces: batteryIn, solarUsed, batteryOut, gas
 */
function plotYearlyProfileChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  const xVals = [...Array(HOURS_PER_YEAR).keys()]; // 0..8759

  const traceBatteryIn = {
    x: xVals,
    y: batteryIn,
    name: 'Battery In (Charging)',
    type: 'bar',
    marker: { color: '#4db6e4' }
  };
  const traceSolar = {
    x: xVals,
    y: solarUsed,
    name: 'Solar (Used)',
    type: 'bar',
    marker: { color: '#f4d44d' }
  };
  const traceBatteryOut = {
    x: xVals,
    y: batteryOut,
    name: 'Battery Out',
    type: 'bar',
    marker: { color: '#4db6e4' }
  };
  const traceGas = {
    x: xVals,
    y: gasUsed,
    name: 'Gas',
    type: 'bar',
    marker: { color: '#f45d5d' }
  };

  const data = [traceBatteryIn, traceSolar, traceBatteryOut, traceGas];

  const layout = {
    title: 'Yearly Profile (8760 hours)',
    barmode: 'relative', // stacked
    xaxis: { title: 'Hour of Year', range: [0, 8760] },
    yaxis: { title: 'MWh/h' },
    dragmode: 'zoom'
  };

  Plotly.newPlot('yearlyProfileChart', data, layout, {scrollZoom: true});
}

/**
 * 3) Jan Chart => first 7 days
 */
function plotJanChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  const janStart = 0;
  const janEnd = 24*7;
  const xVals = [...Array(janEnd - janStart).keys()];

  const traceBatteryIn = {
    x: xVals,
    y: batteryIn.slice(janStart, janEnd),
    name: 'Battery In (Charging)',
    type: 'bar',
    marker: { color: '#4db6e4' }
  };
  const traceSolar = {
    x: xVals,
    y: solarUsed.slice(janStart, janEnd),
    name: 'Solar (Used)',
    type: 'bar',
    marker: { color: '#f4d44d' }
  };
  const traceBatteryOut = {
    x: xVals,
    y: batteryOut.slice(janStart, janEnd),
    name: 'Battery Out',
    type: 'bar',
    marker: { color: '#4db6e4' }
  };
  const traceGas = {
    x: xVals,
    y: gasUsed.slice(janStart, janEnd),
    name: 'Gas',
    type: 'bar',
    marker: { color: '#f45d5d' }
  };

  const data = [traceBatteryIn, traceSolar, traceBatteryOut, traceGas];

  const layout = {
    title: 'January (First 7 Days)',
    barmode: 'relative',
    xaxis: { title: 'Hour of January' },
    yaxis: { title: 'MWh/h' },
    dragmode: 'zoom'
  };

  Plotly.newPlot('janProfileChart', data, layout, {scrollZoom: true});
}

/**
 * 4) July Chart => ~ mid-year => pick 7 days from end of June
 */
function plotJulChart(solarUsed, batteryOut, gasUsed, batteryIn) {
  const julStart = 24*(31+28+31+30+31+30); 
  const julEnd = julStart + (24*7);
  const xVals = [...Array(julEnd - julStart).keys()];

  const traceBatteryIn = {
    x: xVals,
    y: batteryIn.slice(julStart, julEnd),
    name: 'Battery In (Charging)',
    type: 'bar',
    marker: { color: '#4db6e4' }
  };
  const traceSolar = {
    x: xVals,
    y: solarUsed.slice(julStart, julEnd),
    name: 'Solar (Used)',
    type: 'bar',
    marker: { color: '#f4d44d' }
  };
  const traceBatteryOut = {
    x: xVals,
    y: batteryOut.slice(julStart, julEnd),
    name: 'Battery Out',
    type: 'bar',
    marker: { color: '#4db6e4' }
  };
  const traceGas = {
    x: xVals,
    y: gasUsed.slice(julStart, julEnd),
    name: 'Gas',
    type: 'bar',
    marker: { color: '#f45d5d' }
  };

  const data = [traceBatteryIn, traceSolar, traceBatteryOut, traceGas];

  const layout = {
    title: 'July (7 Days)',
    barmode: 'relative',
    xaxis: { title: 'Hour of July' },
    yaxis: { title: 'MWh/h' },
    dragmode: 'zoom'
  };

  Plotly.newPlot('julProfileChart', data, layout, {scrollZoom: true});
}

/**
 * 5) LCOE Breakdown => bar chart with Gas, Solar, Battery
 */
function plotLcoeBreakdownChart(vals) {
  const { gasCapex, gasOpex, solarCapex, solarOpex, batteryCapex, batteryOpex } = vals;

  const traceCapex = {
    x: ['Gas', 'Solar', 'Battery'],
    y: [gasCapex, solarCapex, batteryCapex],
    name: 'Capex (GBP/MWh)',
    type: 'bar',
    marker: { color: '#7777ff' }
  };
  const traceOpex = {
    x: ['Gas', 'Solar', 'Battery'],
    y: [gasOpex, solarOpex, batteryOpex],
    name: 'Opex (GBP/MWh)',
    type: 'bar',
    marker: { color: '#aaaaaa' }
  };

  const data = [traceCapex, traceOpex];
  const layout = {
    title: 'Levelized Cost Breakdown',
    barmode: 'stack',
    xaxis: { title: '' },
    yaxis: { title: 'GBP/MWh' },
    dragmode: 'zoom'
  };

  Plotly.newPlot('lcoeBreakdownChart', data, layout, {scrollZoom: true});
}
