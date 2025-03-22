/***************************************************
 * model.js
 * Creates 5 charts:
 *  1) Yearly Profile (#yearlyChart)
 *  2) January (#janChart)
 *  3) July (#julChart)
 *  4) Generation Mix (#genMixChart) [horizontal bar]
 *  5) LCOE Breakdown (#lcoeChart)   [horizontal bar]
 * 
 * Summaries in #summary
 ***************************************************/

// Chart references
let yearlyProfileChart, janChart, julChart, genMixChart, lcoeChart;

// We do a fake daily solar pattern: hours 8..17 => 70% of nameplate
const HOURS_PER_YEAR = 8760;

// Main run function
function runModel() {
  // 1) Gather inputs
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
  const gasEfficiency = (parseFloat(document.getElementById("gasEfficiency").value)||45)/100;

  const inverterRatio = parseFloat(document.getElementById("inverterRatio").value)||1.2;
  const waccFossil = (parseFloat(document.getElementById("waccFossil").value)||8)/100;
  const waccRenew  = (parseFloat(document.getElementById("waccRenew").value)||5)/100;

  const lifetimeFossil= parseFloat(document.getElementById("lifetimeFossil").value)||25;
  const lifetimeSolar = parseFloat(document.getElementById("lifetimeSolar").value)||35;

  // Convert to MW, MWh
  const solarCapMW = solarCapGW*1000;
  const batteryCapMWh = batteryCapGWh*1000;

  // 2) Dispatch Model
  let batterySoC = 0;
  const solarFlow= new Array(HOURS_PER_YEAR).fill(0); // total solar each hour
  const batteryIn= new Array(HOURS_PER_YEAR).fill(0); // negative => charging
  const batteryOut=new Array(HOURS_PER_YEAR).fill(0);
  const gasOut   = new Array(HOURS_PER_YEAR).fill(0);

  const maxSolarAC = solarCapMW/inverterRatio;

  for(let h=0; h<HOURS_PER_YEAR; h++){
    let demand = 1000; // MWh/h
    // Fake daily pattern
    const hourOfDay = h%24;
    let rawSolarMW=0;
    if(hourOfDay>=8 && hourOfDay<18){
      rawSolarMW = solarCapMW*0.7; // 70%
    }
    const clippedSolarMW= Math.min(rawSolarMW, maxSolarAC);
    solarFlow[h]= clippedSolarMW;

    // Use solar
    const usedSolar= Math.min(clippedSolarMW, demand);
    demand -= usedSolar;

    // leftover
    let leftoverSolar= clippedSolarMW - usedSolar;
    // charge battery
    if(leftoverSolar>0 && batterySoC< batteryCapMWh){
      const space= batteryCapMWh- batterySoC;
      const charge= Math.min(leftoverSolar, space);
      batterySoC += charge;
      batteryIn[h]= -charge; // negative => charging
      leftoverSolar -= charge;
    }

    // if demand remains, discharge battery
    if(demand>0 && batterySoC>0){
      const discharge= Math.min(demand, batterySoC);
      batterySoC-= discharge;
      batteryOut[h]= discharge;
      demand-= discharge;
    }

    // if still demand, use gas
    if(demand>0){
      gasOut[h]= demand;
      demand=0;
    }
  }

  // Summaries
  const totalSolarMWh   = sumArray(solarFlow);
  const totalBatteryMWh = sumArray(batteryOut);
  const totalGasMWh     = sumArray(gasOut);
  const totalDemandMWh  = HOURS_PER_YEAR*1000; // 8,760,000

  // Now we figure out how much solar actually served load => solarUsed
  // We'll call that "usedSolarFlow" => difference between solarFlow minus leftover
  // Actually we can do it simpler: totalDemand - battery - gas
  const solarUsedMWh = totalDemandMWh - totalBatteryMWh - totalGasMWh;

  // 3) LCOE
  // a) Gas => 1 GW => 1000 MW
  const gasCapMW=1000;
  const gasCapexTotal= gasCapMW*1000* gasCapex;
  const crfGas= calcCRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex= gasCapexTotal* crfGas;
  const gasAnnualFixedOM= gasCapMW* gasFixedOM;
  // Fuel => (gasMWh / efficiency)* gasFuel
  const totalGasFuel= (totalGasMWh/ gasEfficiency)* gasFuel;
  const totalGasVarOM= totalGasMWh* gasVarOM;
  const gasAnnualCost= gasAnnualCapex + gasAnnualFixedOM + totalGasFuel + totalGasVarOM;

  // b) Solar
  const solarCapexTotal= solarCapMW*1000* solarCapex;
  const crfSolar= calcCRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex= solarCapexTotal* crfSolar;
  const solarAnnualFixedOM= solarCapMW* solarFixedOM;
  const solarAnnualCost= solarAnnualCapex + solarAnnualFixedOM;

  // c) Battery
  const batteryCapexTotal= batteryCapMWh*1000* batteryCapex;
  const crfBattery= calcCRF(waccRenew, 25); // assume 25 yrs
  const batteryAnnualCapex= batteryCapexTotal* crfBattery;
  const batteryMW= batteryCapMWh/4;
  const batteryAnnualFixedOM= batteryMW* batteryFixedOM;
  const batteryAnnualCost= batteryAnnualCapex + batteryAnnualFixedOM;

  // LCOE denominators:
  // Gas => totalGasMWh
  // Solar => solarUsedMWh
  // Battery => totalBatteryMWh
  const gasLcoe= (totalGasMWh>0)? gasAnnualCost/ totalGasMWh :0;
  const solarLcoe= (solarUsedMWh>0)? solarAnnualCost/ solarUsedMWh:0;
  const batteryLcoe= (totalBatteryMWh>0)? batteryAnnualCost/ totalBatteryMWh:0;

  const totalAnnualCost= gasAnnualCost + solarAnnualCost + batteryAnnualCost;
  const systemLcoe= totalAnnualCost/ totalDemandMWh;

  // 4) Render the 5 charts
  // (A) Yearly => stacked bar
  updateYearlyChart(solarFlow, batteryIn, batteryOut, gasOut);
  // (B) January => stacked bar
  updateJanChart(solarFlow, batteryIn, batteryOut, gasOut);
  // (C) July => stacked bar
  updateJulChart(solarFlow, batteryIn, batteryOut, gasOut);

  // (D) Gen Mix => single horizontal bar
  updateGenMixChart(totalGasMWh, solarUsedMWh, totalBatteryMWh);

  // (E) LCOE => single horizontal bar with 6 segments
  // Gas => capex + opex
  const gasCapexLcoe= (totalGasMWh>0)? gasAnnualCapex/ totalGasMWh:0;
  const gasOpexLcoe = (totalGasMWh>0)? ((gasAnnualFixedOM+ totalGasFuel+ totalGasVarOM)/ totalGasMWh):0;
  // Solar => capex + opex
  const solarCapexLcoe= (solarUsedMWh>0)? solarAnnualCapex/ solarUsedMWh:0;
  const solarOpexLcoe = (solarUsedMWh>0)? solarAnnualFixedOM/ solarUsedMWh:0;
  // Battery => capex + opex
  const batteryCapexLcoe= (totalBatteryMWh>0)? batteryAnnualCapex/ totalBatteryMWh:0;
  const batteryOpexLcoe = (totalBatteryMWh>0)? batteryAnnualFixedOM/ totalBatteryMWh:0;

  updateLcoeChart(gasCapexLcoe, gasOpexLcoe,
                  solarCapexLcoe, solarOpexLcoe,
                  batteryCapexLcoe, batteryOpexLcoe,
                  systemLcoe);

  // 5) Fill #summary
  const summaryDiv= document.getElementById("summary");
  summaryDiv.innerHTML= `
    <p><strong>Solar Generated:</strong> ${Math.round(totalSolarMWh).toLocaleString()} MWh (of which used: ${Math.round(solarUsedMWh).toLocaleString()})</p>
    <p><strong>Battery Discharge:</strong> ${Math.round(totalBatteryMWh).toLocaleString()} MWh</p>
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

/** Summation helper */
function sumArray(arr){ return arr.reduce((a,b)=>a+b,0); }

/** CRF => annualize cost */
function calcCRF(rate, yrs){
  if(rate===0) return 1/yrs;
  const top= rate* Math.pow(1+rate, yrs);
  const bot= Math.pow(1+rate, yrs)-1;
  return top/bot;
}

/** ============= Charts ============= **/

/** 1) Yearly => stacked bar (8760 hours) => might be big but for demo */
function updateYearlyChart(solarFlow, batteryIn, batteryOut, gasOut){
  if(yearlyProfileChart) yearlyProfileChart.destroy();
  const ctx= document.getElementById("yearlyChart").getContext("2d");

  const labels= [...Array(HOURS_PER_YEAR).keys()];
  yearlyProfileChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels,
      datasets:[
        {
          label:"Solar (All Generation)",
          data: solarFlow,
          backgroundColor:"#13ce74",
          stack:"stack"
        },
        {
          label:"Battery In (Charging)",
          data: batteryIn,
          backgroundColor:"#4db6e4",
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
        x:{ stacked:true, title:{display:true, text:"Hour of Year"} },
        y:{ stacked:true, title:{display:true, text:"MWh/h"} }
      },
      plugins:{
        title:{ display:true, text:"Yearly Profile (8760 hours)" }
      }
    }
  });
}

/** 2) Jan => first 7 days => hours 0..168 */
function updateJanChart(solarFlow, batteryIn, batteryOut, gasOut){
  if(janChart) janChart.destroy();
  const ctx= document.getElementById("janChart").getContext("2d");

  const janStart=0, janEnd=24*7; // first 7 days
  const labels= [...Array(janEnd- janStart).keys()];
  const sliceSolar= solarFlow.slice(janStart, janEnd);
  const sliceBattIn= batteryIn.slice(janStart, janEnd);
  const sliceBattOut= batteryOut.slice(janStart, janEnd);
  const sliceGas= gasOut.slice(janStart, janEnd);

  janChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels,
      datasets:[
        {
          label:"Solar (All Generation)",
          data: sliceSolar,
          backgroundColor:"#13ce74",
          stack:"stack"
        },
        {
          label:"Battery In (Charging)",
          data: sliceBattIn,
          backgroundColor:"#4db6e4",
          stack:"stack"
        },
        {
          label:"Battery Out",
          data: sliceBattOut,
          backgroundColor:"rgba(77,182,228,0.5)",
          stack:"stack"
        },
        {
          label:"Gas",
          data: sliceGas,
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
        title:{ display:true, text:"January (First 7 Days)" }
      }
    }
  });
}

/** 3) July => pick 7 days from end of June => hours ~ 4320..4320+168 */
function updateJulChart(solarFlow, batteryIn, batteryOut, gasOut){
  if(julChart) julChart.destroy();
  const ctx= document.getElementById("julChart").getContext("2d");

  const julStart= 24*(31+28+31+30+31+30); // end of june
  const julEnd= julStart+ (24*7);
  const labels= [...Array(julEnd- julStart).keys()];
  const sliceSolar= solarFlow.slice(julStart, julEnd);
  const sliceBattIn= batteryIn.slice(julStart, julEnd);
  const sliceBattOut= batteryOut.slice(julStart, julEnd);
  const sliceGas= gasOut.slice(julStart, julEnd);

  julChart= new Chart(ctx, {
    type:"bar",
    data:{
      labels,
      datasets:[
        {
          label:"Solar (All Generation)",
          data: sliceSolar,
          backgroundColor:"#13ce74",
          stack:"stack"
        },
        {
          label:"Battery In (Charging)",
          data: sliceBattIn,
          backgroundColor:"#4db6e4",
          stack:"stack"
        },
        {
          label:"Battery Out",
          data: sliceBattOut,
          backgroundColor:"rgba(77,182,228,0.5)",
          stack:"stack"
        },
        {
          label:"Gas",
          data: sliceGas,
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
        title:{ display:true, text:"July (7 Days)" }
      }
    }
  });
}

/** 4) Generation Mix => single horizontal bar => Gas, SolarUsed, Battery */
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
        x:{ stacked:true, title:{display:true,text:"MWh"} },
        y:{ stacked:true }
      },
      plugins:{
        title:{ display:true, text:"Generation Mix (MWh)" }
      }
    }
  });
}

/** 5) LCOE => single horizontal bar => 6 segments */
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
        x:{ stacked:true, title:{display:true,text:"GBP/MWh"} },
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
