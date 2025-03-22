/***************************************************
 * model.js
 * Example LCOE calculator with 2 horizontal bar charts:
 * - Generation Mix (#genMixChart)
 * - LCOE Breakdown (#lcoeChart)
 *
 * Dispatch:
 *   1 GW baseload => 1000 MWh/h
 *   Fake solar profile: hours 8..17 => some solar
 *   Battery: charges from surplus, discharges to meet load
 *   Gas covers remainder
 *
 * Gas efficiency => total fuel cost = (gasMWh / gasEfficiency) * gasFuel
 ***************************************************/

// Chart references (so we can destroy if needed)
let genMixChart, lcoeChart;

// Hard-coded constants
const HOURS_PER_YEAR = 8760;

// Main function triggered by "Run Model" button
function runModel() {
  // 1) Gather user inputs from the sidebar
  const solarCapGW   = parseFloat(document.getElementById("solarCap").value)   || 0;
  const batteryCapGWh= parseFloat(document.getElementById("batteryCap").value)|| 0;

  const gasCapex     = parseFloat(document.getElementById("gasCapex").value)     || 800;   // GBP/kW
  const solarCapex   = parseFloat(document.getElementById("solarCapex").value)   || 450;   // GBP/kW
  const batteryCapex = parseFloat(document.getElementById("batteryCapex").value) || 200;   // GBP/kWh

  const gasFixedOM   = parseFloat(document.getElementById("gasFixedOM").value)   || 18000; // GBP/MW/yr
  const solarFixedOM = parseFloat(document.getElementById("solarFixedOM").value) || 8000;
  const batteryFixedOM= parseFloat(document.getElementById("batteryFixedOM").value)||6000;

  const gasVarOM     = parseFloat(document.getElementById("gasVarOM").value)     || 4;     // GBP/MWh
  const gasFuel      = parseFloat(document.getElementById("gasFuel").value)      || 40;    // GBP per MWh_fuel
  const gasEfficiency= (parseFloat(document.getElementById("gasEfficiency").value)||45)/100;

  const inverterRatio= parseFloat(document.getElementById("inverterRatio").value)|| 1.2;
  const waccFossil   = (parseFloat(document.getElementById("waccFossil").value)  || 8)/100;
  const waccRenew    = (parseFloat(document.getElementById("waccRenew").value)   || 5)/100;

  const lifetimeFossil= parseFloat(document.getElementById("lifetimeFossil").value)||25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value)||35;

  // Convert capacities
  const solarCapMW    = solarCapGW * 1000;        // from GW to MW
  const batteryCapMWh = batteryCapGWh * 1000;     // from GWh to MWh

  // 2) Dispatch model
  // We'll do a naive approach:
  //   for each hour: demand=1000 MWh
  //   if hour in 8..17 => solar = solarCapMW * 0.7 (some fraction)
  //   clipped by AC ratio
  //   leftover => battery
  //   if demand remains => discharge battery
  //   if demand remains => gas

  let batterySoC = 0;
  const usedSolar = new Array(HOURS_PER_YEAR).fill(0);
  const batteryOut= new Array(HOURS_PER_YEAR).fill(0);
  const gasOut    = new Array(HOURS_PER_YEAR).fill(0);

  const maxSolarAC = solarCapMW / inverterRatio;

  for(let h=0; h<HOURS_PER_YEAR; h++){
    let demand = 1000; // 1 GW => 1000 MWh/h

    // Fake solar shape
    const hourOfDay = h % 24;
    let rawSolarMW = 0;
    if(hourOfDay >= 8 && hourOfDay < 18) {
      // e.g. 70% of nameplate
      rawSolarMW = solarCapMW * 0.7;
    }
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // Use solar
    const solarToLoad = Math.min(clippedSolarMW, demand);
    usedSolar[h] = solarToLoad;
    demand -= solarToLoad;

    // Surplus leftover
    let leftoverSolar = clippedSolarMW - solarToLoad;

    // Charge battery if leftover
    if(leftoverSolar > 0 && batterySoC < batteryCapMWh) {
      const space = batteryCapMWh - batterySoC;
      const charge = Math.min(leftoverSolar, space);
      batterySoC += charge;
      leftoverSolar -= charge;
    }
    // leftoverSolar is curtailed if any remains

    // If demand remains, discharge battery
    if(demand>0 && batterySoC>0) {
      const discharge = Math.min(demand, batterySoC);
      batterySoC -= discharge;
      batteryOut[h] = discharge;
      demand -= discharge;
    }

    // If still demand, use gas
    if(demand>0) {
      gasOut[h] = demand;
      demand=0;
    }
  }

  // Summaries
  const totalUsedSolarMWh  = sumArray(usedSolar);
  const totalBatteryMWh    = sumArray(batteryOut);
  const totalGasMWh        = sumArray(gasOut);
  const totalDemandMWh     = HOURS_PER_YEAR * 1000; // 8,760,000 MWh

  // 3) LCOE Calculations
  // a) Gas => 1 GW => 1000 MW
  // CapEx in GBP/kW => multiply MW by 1000
  const gasCapMW = 1000;
  const gasCapexTotal = gasCapMW * 1000 * gasCapex; // GBP
  const crfGas = calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex = gasCapexTotal * crfGas; // GBP/yr
  const gasAnnualFixedOM= gasCapMW * gasFixedOM; // GBP/yr
  // Fuel cost => (gasMWh / efficiency) * gasFuel
  const totalGasFuel = (totalGasMWh / gasEfficiency) * gasFuel;
  const totalGasVarOM= totalGasMWh * gasVarOM;
  const gasAnnualCost= gasAnnualCapex + gasAnnualFixedOM + totalGasFuel + totalGasVarOM;

  // b) Solar
  // capacity in MW => solarCapMW, cost in GBP/kW => multiply by 1000
  const solarCapexTotal = solarCapMW * 1000 * solarCapex;
  const crfSolar = calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex = solarCapexTotal * crfSolar;
  const solarAnnualFixedOM= solarCapMW * solarFixedOM;
  const solarAnnualCost= solarAnnualCapex + solarAnnualFixedOM;

  // c) Battery
  // capacity in MWh => batteryCapMWh, cost in GBP/kWh => multiply by 1000
  const batteryCapexTotal = batteryCapMWh * 1000 * batteryCapex;
  // assume 25 year battery
  const crfBattery = calcCRF(waccRenew, 25);
  const batteryAnnualCapex = batteryCapexTotal * crfBattery;
  // approximate battery MW => e.g. batteryCapMWh / 4
  const batteryMW = batteryCapMWh / 4;
  const batteryAnnualFixedOM = batteryMW * batteryFixedOM;
  const batteryAnnualCost = batteryAnnualCapex + batteryAnnualFixedOM;

  // LCOE for each
  const gasLcoe = (totalGasMWh>0) ? gasAnnualCost/ totalGasMWh : 0;
  const solarLcoe= (totalUsedSolarMWh>0)? solarAnnualCost/ totalUsedSolarMWh:0;
  const batteryLcoe=(totalBatteryMWh>0)? batteryAnnualCost/ totalBatteryMWh:0;

  // Weighted total system LCOE => sum annual costs / total load
  const totalAnnualCost = gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe = totalAnnualCost / totalDemandMWh;

  // For generation mix chart => single bar with [gas, solar, battery]
  // We'll do absolute MWh or %? Let's do absolute MWh
  // Then we can do horizontal stacked bar
  updateGenMixChart(totalGasMWh, totalUsedSolarMWh, totalBatteryMWh);

  // For LCOE breakdown => single bar with 6 segments (capex, opex for each)
  // We define each in GBP/MWh
  // Gas capex => (gasAnnualCapex / totalGasMWh) or 0 if no gas
  const gasCapexLcoe = (totalGasMWh>0)? (gasAnnualCapex/ totalGasMWh):0;
  const gasOpexLcoe  = (totalGasMWh>0)? ((gasAnnualFixedOM + totalGasVarOM + totalGasFuel)/ totalGasMWh):0;
  const solarCapexLcoe= (totalUsedSolarMWh>0)? (solarAnnualCapex/ totalUsedSolarMWh):0;
  const solarOpexLcoe = (totalUsedSolarMWh>0)? (solarAnnualFixedOM/ totalUsedSolarMWh):0;
  const batteryCapexLcoe= (totalBatteryMWh>0)? (batteryAnnualCapex/ totalBatteryMWh):0;
  const batteryOpexLcoe = (totalBatteryMWh>0)? (batteryAnnualFixedOM/ totalBatteryMWh):0;

  updateLcoeChart(
    gasCapexLcoe, gasOpexLcoe,
    solarCapexLcoe, solarOpexLcoe,
    batteryCapexLcoe, batteryOpexLcoe,
    systemLcoe
  );
}

/** Sum helper */
function sumArray(arr) {
  return arr.reduce((a,b) => a+b, 0);
}

/** Capital Recovery Factor => annualize a lump-sum cost */
function calcCRF(rate, years) {
  if(rate===0) return 1/years;
  const top= rate * Math.pow(1+rate, years);
  const bot= Math.pow(1+rate, years)-1;
  return top/bot;
}

/**
 * Update the Generation Mix chart (#genMixChart) as a horizontal bar
 * We'll do 1 label => "Generation Mix"
 * data => [gasMWh, solarMWh, batteryMWh]
 */
function updateGenMixChart(gasMWh, solarMWh, batteryMWh) {
  // Destroy old chart if exists
  if(genMixChart) genMixChart.destroy();
  const ctx = document.getElementById("genMixChart").getContext("2d");

  // Single bar => stacked horizontally
  genMixChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Generation Mix"],
      datasets: [
        {
          label: "Gas",
          data: [gasMWh],
          backgroundColor: "#f45d5d", // or use a green if you prefer
          stack: "gen"
        },
        {
          label: "Solar",
          data: [solarMWh],
          backgroundColor: "#13ce74",
          stack: "gen"
        },
        {
          label: "Battery",
          data: [batteryMWh],
          backgroundColor: "#4db6e4",
          stack: "gen"
        }
      ]
    },
    options: {
      indexAxis: 'y', // horizontal
      responsive: true,
      scales: {
        x: { stacked: true, title:{display:true, text:"MWh"} },
        y: { stacked: true }
      },
      plugins:{
        title:{
          display:true,
          text:"Generation Mix (MWh)"
        }
      }
    }
  });
}

/**
 * Update the LCOE chart (#lcoeChart) => single horizontal bar with 6 segments:
 *   Gas CapEx, Gas OpEx, Solar CapEx, Solar OpEx, Battery CapEx, Battery OpEx
 * Summation => total system LCOE
 */
function updateLcoeChart(
  gasCapexLcoe, gasOpexLcoe,
  solarCapexLcoe, solarOpexLcoe,
  batteryCapexLcoe, batteryOpexLcoe,
  systemLcoe
) {
  if(lcoeChart) lcoeChart.destroy();
  const ctx = document.getElementById("lcoeChart").getContext("2d");

  // single bar => 6 stacked segments
  lcoeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["System LCOE"],
      datasets: [
        {
          label: "Gas CapEx",
          data: [gasCapexLcoe],
          backgroundColor: "#f45d5d", // or your chosen color
          stack: "lcoe"
        },
        {
          label: "Gas OpEx",
          data: [gasOpexLcoe],
          backgroundColor: "rgba(244,93,93,0.5)",
          stack: "lcoe"
        },
        {
          label: "Solar CapEx",
          data: [solarCapexLcoe],
          backgroundColor: "#13ce74",
          stack: "lcoe"
        },
        {
          label: "Solar OpEx",
          data: [solarOpexLcoe],
          backgroundColor: "rgba(19,206,116,0.5)",
          stack: "lcoe"
        },
        {
          label: "Battery CapEx",
          data: [batteryCapexLcoe],
          backgroundColor: "#4db6e4",
          stack: "lcoe"
        },
        {
          label: "Battery OpEx",
          data: [batteryOpexLcoe],
          backgroundColor: "rgba(77,182,228,0.5)",
          stack: "lcoe"
        }
      ]
    },
    options: {
      indexAxis: 'y', // horizontal
      responsive: true,
      scales: {
        x: { stacked: true, title:{display:true, text:"GBP/MWh"} },
        y: { stacked: true }
      },
      plugins:{
        title:{
          display:true,
          text:`Total System LCOE ~ ${systemLcoe.toFixed(2)} GBP/MWh`
        }
      }
    }
  });
}
