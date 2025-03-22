/***************************************************
 * model.js
 * 
 * 1) On window load, parse "solarprofile.csv" with PapaParse,
 *    storing 8760 values in solarProfile[].
 * 2) When user clicks "Update" button => runModel().
 * 3) Dispatch 1 GW baseload with solar + battery + gas,
 *    using real solarProfile data.
 * 4) Calculate LCOE (Gas efficiency included in fuel cost).
 * 5) Render 5 charts:
 *    - Generation Mix (horizontal single bar)
 *    - LCOE Breakdown (horizontal single bar, 6 segments)
 *    - Yearly Profile (stacked bar, 8760 hours)
 *    - January (first 7 days)
 *    - July (7 days from end of June)
 ***************************************************/

// Chart references (so we can destroy old instances if needed)
let genMixChart, lcoeChart, yearlyChart, janChart, julChart;

// Store the 8760-hour solar capacity factor data
let solarProfile = [];

// Constants
const HOURS_PER_YEAR = 8760;

window.onload = () => {
  // Parse the CSV on page load
  Papa.parse("solarprofile.csv", {
    download: true,
    header: true,
    dynamicTyping: true,
    complete: (results) => {
      // Store the "electricity" column in solarProfile array
      solarProfile = results.data.map(row => row.electricity || 0);
      console.log("Solar profile loaded. Sample first 24h:", solarProfile.slice(0,24));

      // Hook up the "Update" button
      const btn = document.getElementById("updateBtn");
      if(btn){
        btn.addEventListener("click", runModel);
      }
    }
  });
};

/**
 * Main LCOE function triggered by "Update" button
 */
function runModel(){
  // 1) Read user inputs from the sidebar
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

  // Convert to consistent units
  const solarCapMW    = solarCapGW * 1000;         // from GW to MW
  const batteryCapMWh = batteryCapGWh * 1000;      // from GWh to MWh

  // 2) Dispatch model for 1 GW baseload => 1000 MWh/h
  if(solarProfile.length < HOURS_PER_YEAR){
    alert("solarprofile.csv not fully loaded or missing data!");
    return;
  }

  let batterySoC = 0;
  const solarUsed = new Array(HOURS_PER_YEAR).fill(0);
  const batteryOut= new Array(HOURS_PER_YEAR).fill(0);
  const gasOut    = new Array(HOURS_PER_YEAR).fill(0);
  const batteryIn = new Array(HOURS_PER_YEAR).fill(0);

  const maxSolarAC = solarCapMW / inverterRatio;

  for(let h=0; h<HOURS_PER_YEAR; h++){
    let demand = 1000; // MWh/h

    // Real solar: capacity factor from solarProfile[h]
    const rawSolarMW = solarProfile[h] * solarCapMW;
    const clippedSolarMW = Math.min(rawSolarMW, maxSolarAC);

    // 1) Use solar
    const used = Math.min(clippedSolarMW, demand);
    solarUsed[h] = used;
    demand -= used;

    // leftover
    let leftoverSolar = clippedSolarMW - used;

    // 2) charge battery
    if(leftoverSolar>0 && batterySoC< batteryCapMWh){
      const space = batteryCapMWh - batterySoC;
      const charge = Math.min(leftoverSolar, space);
      batterySoC += charge;
      batteryIn[h] = -charge; // negative => charging
      leftoverSolar -= charge;
    }

    // 3) discharge battery if demand remains
    if(demand>0 && batterySoC>0){
      const discharge = Math.min(demand, batterySoC);
      batterySoC -= discharge;
      batteryOut[h] = discharge;
      demand -= discharge;
    }

    // 4) if still demand => gas
    if(demand>0){
      gasOut[h] = demand;
      demand=0;
    }
  }

  // Summaries
  const totalSolarMWh  = sumArray(solarUsed);
  const totalBatteryMWh= sumArray(batteryOut);
  const totalGasMWh    = sumArray(gasOut);
  const totalDemandMWh = HOURS_PER_YEAR * 1000; // 8,760,000

  // 3) LCOE
  // a) Gas => 1 GW => 1000 MW
  const gasCapMW = 1000; // 1 GW
  const gasCapexTotal = gasCapMW*1000* gasCapex; // (MW->kW)
  const crfGas= calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex= gasCapexTotal* crfGas;
  const gasAnnualFixedOM= gasCapMW* gasFixedOM;

  // Fuel => (gasMWh / efficiency)* gasFuel
  const gasFuelCost= (totalGasMWh / gasEfficiency)* gasFuel;
  const gasVarCost= totalGasMWh* gasVarOM;
  const gasAnnualCost= gasAnnualCapex+ gasAnnualFixedOM+ gasFuelCost+ gasVarCost;

  // b) Solar
  const solarCapexTotal= solarCapMW*1000* solarCapex;
  const crfSolar= calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex= solarCapexTotal* crfSolar;
  const solarAnnualFixedOM= solarCapMW* solarFixedOM;
  const solarAnnualCost= solarAnnualCapex+ solarAnnualFixedOM;

  // c) Battery
  const batteryCapexTotal= batteryCapMWh*1000* batteryCapex;
  const crfBattery= calcCRF(waccRenew, 25); // assume 25 yrs
  const batteryAnnualCapex= batteryCapexTotal* crfBattery;
  // approximate battery MW => MWh/4
  const batteryMW= batteryCapMWh/4;
  const batteryAnnualFixedOM= batteryMW* batteryFixedOM;
  const batteryAnnualCost= batteryAnnualCapex+ batteryAnnualFixedOM;

  // LCOE denominators
  const gasLcoe= (totalGasMWh>0)? gasAnnualCost/ totalGasMWh :0;
  const solarLcoe= (totalSolarMWh>0)? solarAnnualCost/ totalSolarMWh:0;
  const batteryLcoe= (totalBatteryMWh>0)? batteryAnnualCost/ totalBatteryMWh:0;

  // Weighted total => sum(annual costs)/ totalDemandMWh
  const totalAnnualCost= gasAnnualCost+ solarAnnualCost+ batteryAnnualCost;
  const systemLcoe= totalAnnualCost/ totalDemandMWh;

  // 4) Render Generation Mix => single horizontal bar
  updateGenMixChart(totalGasMWh, totalSolarMWh, totalBatteryMWh);

  // 5) Render LCOE => single horizontal bar with 6 segments
  // Gas => capex + opex
  const gasCapexLcoe= (totalGasMWh>0)? (gasAnnualCapex/ totalGasMWh):0;
  const gasOpexLcoe= (totalGasMWh>0)? ((gasAnnualFixedOM+ gasFuelCost+ gasVarCost)/ totalGasMWh):0;

  // Solar => capex + opex
  const solarCapexLcoe= (totalSolarMWh>0)? (solarAnnualCapex/ totalSolarMWh):0;
  const solarOpexLcoe= (totalSolarMWh>0)? (solarAnnualFixedOM/ totalSolarMWh):0;

  // Battery => capex + opex
  const batteryCapexLcoe= (totalBatteryMWh>0)? (batteryAnnualCapex/ totalBatteryMWh):0;
  const batteryOpexLcoe= (totalBatteryMWh>0)? (batteryAnnualFixedOM/ totalBatteryMWh):0;

  updateLcoeChart(
    gasCapexLcoe, gasOpexLcoe,
    solarCapexLcoe, solarOpexLcoe,
    batteryCapexLcoe, batteryOpexLcoe,
    systemLcoe
  );

  // 6) Additional stacked bar charts: Yearly, January, July
  updateYearlyChart(solarUsed, batteryIn, batteryOut, gasOut);
  updateJanChart(solarUsed, batteryIn, batteryOut, gasOut);
  updateJulChart(solarUsed, batteryIn, batteryOut, gasOut);
}

/** Summation helper */
function sumArray(arr){
  return arr.reduce((a,b)=>a+b,0);
}

/** CRF => annualize a lump-sum cost */
function calcCRF(rate, yrs){
  if(rate===0) return 1/yrs;
  const top= rate * Math.pow(1+rate, yrs);
  const bot= Math.pow(1+rate, yrs)-1;
  return top/bot;
}

/** ========== CHARTS ========== **/

// 1) Generation Mix => single horizontal bar
function updateGenMixChart(gasMWh, solarMWh, batteryMWh){
  if(genMixChart) genMixChart.destroy();
  const ctx= document.getElementById("genMixChart").getContext("2d");
  genMixChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels:["Generation Mix"],
      datasets:[
        {
          label:"Gas",
          data:[gasMWh],
          backgroundColor:"#f45d5d",
          stack:"mix"
        },
        {
          label:"Solar",
          data:[solarMWh],
          backgroundColor:"#13ce74",
          stack:"mix"
        },
        {
          label:"Battery",
          data:[batteryMWh],
          backgroundColor:"#4db6e4",
          stack:"mix"
        }
      ]
    },
    options:{
      indexAxis:"y",
      responsive:true,
      scales:{
        x:{ stacked:true, title:{display:true, text:"MWh"} },
        y:{ stacked:true }
      },
      plugins:{
        title:{ display:true, text:"Generation Mix (MWh)" }
      }
    }
  });
}

// 2) LCOE => single horizontal bar with 6 segments
function updateLcoeChart(
  gasCapex, gasOpex,
  solarCapex, solarOpex,
  batteryCapex, batteryOpex,
  systemLcoe
){
  if(lcoeChart) lcoeChart.destroy();
  const ctx= document.getElementById("lcoeChart").getContext("2d");

  lcoeChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels:["System LCOE"],
      datasets:[
        {
          label:"Gas CapEx",
          data:[gasCapex],
          backgroundColor:"#f45d5d",
          stack:"lcoe"
        },
        {
          label:"Gas OpEx",
          data:[gasOpex],
          backgroundColor:"rgba(244,93,93,0.5)",
          stack:"lcoe"
        },
        {
          label:"Solar CapEx",
          data:[solarCapex],
          backgroundColor:"#13ce74",
          stack:"lcoe"
        },
        {
          label:"Solar OpEx",
          data:[solarOpex],
          backgroundColor:"rgba(19,206,116,0.5)",
          stack:"lcoe"
        },
        {
          label:"Battery CapEx",
          data:[batteryCapex],
          backgroundColor:"#4db6e4",
          stack:"lcoe"
        },
        {
          label:"Battery OpEx",
          data:[batteryOpex],
          backgroundColor:"rgba(77,182,228,0.5)",
          stack:"lcoe"
        }
      ]
    },
    options:{
      indexAxis:"y",
      responsive:true,
      scales:{
        x:{ stacked:true, title:{display:true, text:"GBP/MWh"} },
        y:{ stacked:true }
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

// 3) Yearly Profile => stacked bar (8760 hours): solarUsed, batteryIn(neg?), batteryOut, gas
function updateYearlyChart(solarUsed, batteryIn, batteryOut, gasOut){
  if(yearlyChart) yearlyChart.destroy();
  const ctx= document.getElementById("yearlyChart").getContext("2d");

  const labels= [...Array(HOURS_PER_YEAR).keys()];
  yearlyChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels,
      datasets:[
        {
          label:"Battery In (Charging)",
          data: batteryIn,
          backgroundColor:"#4db6e4",
          stack:"stack"
        },
        {
          label:"Solar Used",
          data: solarUsed,
          backgroundColor:"#13ce74",
          stack:"stack"
        },
        {
          label:"Battery Out",
          data: batteryOut,
          backgroundColor:"rgba(77,182,228,0.5)",
          stack:"stack"
        },
        {
          label:"Gas",
          data: gasOut,
          backgroundColor:"#f45d5d",
          stack:"stack"
        }
      ]
    },
    options:{
      responsive:true,
      animation:false,
      scales:{
        x:{ stacked:true, title:{display:true,text:"Hour of Year"} },
        y:{ stacked:true, title:{display:true,text:"MWh/h"} }
      },
      plugins:{
        title:{ display:true, text:"Yearly Profile (8760 hours)" }
      }
    }
  });
}

// 4) January => first 7 days => 0..167
function updateJanChart(solarUsed, batteryIn, batteryOut, gasOut){
  if(janChart) janChart.destroy();
  const ctx= document.getElementById("janChart").getContext("2d");

  const janStart=0;
  const janEnd=24*7;
  const labels= [...Array(janEnd - janStart).keys()];

  janChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels,
      datasets:[
        {
          label:"Battery In",
          data: batteryIn.slice(janStart, janEnd),
          backgroundColor:"#4db6e4",
          stack:"stack"
        },
        {
          label:"Solar Used",
          data: solarUsed.slice(janStart, janEnd),
          backgroundColor:"#13ce74",
          stack:"stack"
        },
        {
          label:"Battery Out",
          data: batteryOut.slice(janStart, janEnd),
          backgroundColor:"rgba(77,182,228,0.5)",
          stack:"stack"
        },
        {
          label:"Gas",
          data: gasOut.slice(janStart, janEnd),
          backgroundColor:"#f45d5d",
          stack:"stack"
        }
      ]
    },
    options:{
      responsive:true,
      scales:{
        x:{ stacked:true, title:{display:true,text:"Hour of January"} },
        y:{ stacked:true, title:{display:true,text:"MWh/h"} }
      },
      plugins:{
        title:{ display:true, text:"January (7 days)" }
      }
    }
  });
}

// 5) July => 7 days from end of June => ~ hour 4344..4344+168
function updateJulChart(solarUsed, batteryIn, batteryOut, gasOut){
  if(julChart) julChart.destroy();
  const ctx= document.getElementById("julChart").getContext("2d");

  // Approx. Jan(31)+Feb(28)+Mar(31)+Apr(30)+May(31)+Jun(30)=181 days => 181*24=4344
  const julStart= 4344;
  const julEnd= julStart+ (24*7);
  const labels= [...Array(julEnd - julStart).keys()];

  julChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels,
      datasets:[
        {
          label:"Battery In",
          data: batteryIn.slice(julStart, julEnd),
          backgroundColor:"#4db6e4",
          stack:"stack"
        },
        {
          label:"Solar Used",
          data: solarUsed.slice(julStart, julEnd),
          backgroundColor:"#13ce74",
          stack:"stack"
        },
        {
          label:"Battery Out",
          data: batteryOut.slice(julStart, julEnd),
          backgroundColor:"rgba(77,182,228,0.5)",
          stack:"stack"
        },
        {
          label:"Gas",
          data: gasOut.slice(julStart, julEnd),
          backgroundColor:"#f45d5d",
          stack:"stack"
        }
      ]
    },
    options:{
      responsive:true,
      scales:{
        x:{ stacked:true, title:{display:true,text:"Hour of July"} },
        y:{ stacked:true, title:{display:true,text:"MWh/h"} }
      },
      plugins:{
        title:{ display:true, text:"July (7 days)" }
      }
    }
  });
}
