let annualMixChart, lcoeChart, yearlyProfileChart, janProfileChart, julProfileChart;

document.addEventListener("DOMContentLoaded",()=>{
  const btn=document.getElementById("updateBtn");
  if(btn) btn.addEventListener("click", runModel);
});

function runModel(){
  const solarCapGW = parseFloat(document.getElementById("solarCap").value)||0;
  const batteryCapGWh= parseFloat(document.getElementById("batteryCap").value)||0;

  const gasCapex= parseFloat(document.getElementById("gasCapex").value)||800;
  const solarCapex= parseFloat(document.getElementById("solarCapex").value)||450;
  const batteryCapex= parseFloat(document.getElementById("batteryCapex").value)||200;

  const gasFixedOM= parseFloat(document.getElementById("gasFixedOM").value)||18000;
  const solarFixedOM= parseFloat(document.getElementById("solarFixedOM").value)||8000;
  const batteryFixedOM= parseFloat(document.getElementById("batteryFixedOM").value)||6000;

  const gasVarOM= parseFloat(document.getElementById("gasVarOM").value)||4;
  const gasFuel= parseFloat(document.getElementById("gasFuel").value)||40;
  const gasEff= (parseFloat(document.getElementById("gasEfficiency").value)||45)/100;

  const inverterRatio= parseFloat(document.getElementById("inverterRatio").value)||1.2;
  const waccFossil= (parseFloat(document.getElementById("waccFossil").value)||8)/100;
  const waccRenew= (parseFloat(document.getElementById("waccRenew").value)||5)/100;

  const lifetimeFossil= parseFloat(document.getElementById("lifetimeFossil").value)||25;
  const lifetimeSolar= parseFloat(document.getElementById("lifetimeSolar").value)||35;

  const solarCapMW= solarCapGW*1000;
  const batteryCapMWh= batteryCapGWh*1000;

  const HOURS=8760;
  let batterySoC=0;

  const solarUsed= new Array(HOURS).fill(0);
  const batteryOut= new Array(HOURS).fill(0);
  const gasOut= new Array(HOURS).fill(0);
  const batteryIn= new Array(HOURS).fill(0);
  const allSolar= new Array(HOURS).fill(0);

  const maxSolarAC= solarCapMW/ inverterRatio;

  for(let h=0; h<HOURS; h++){
    let demand=1000;
    const hour= h%24;
    let rawSolar=0;
    if(hour>=7 && hour<19) rawSolar= solarCapMW*0.6; // placeholder
    const clipped= Math.min(rawSolar, maxSolarAC);
    allSolar[h]= clipped;

    const used= Math.min(clipped, demand);
    solarUsed[h]= used;
    demand-= used;

    let leftover= clipped- used;
    if(leftover>0 && batterySoC< batteryCapMWh){
      const space= batteryCapMWh- batterySoC;
      const charge= Math.min(leftover, space);
      batterySoC+= charge;
      leftover-= charge;
      batteryIn[h]= -charge;
    }
    if(demand>0 && batterySoC>0){
      const discharge= Math.min(demand, batterySoC);
      batterySoC-= discharge;
      batteryOut[h]= discharge;
      demand-= discharge;
    }
    if(demand>0){
      gasOut[h]= demand;
      demand=0;
    }
  }

  const totalSolarUsed= sum(solarUsed);
  const totalBattery= sum(batteryOut);
  const totalGas= sum(gasOut);
  const totalDemand= HOURS*1000;

  // LCOE
  const gasCapMW=1000;
  const gasCapexTotal= gasCapMW*1000* gasCapex;
  const crfGas= CRF(waccFossil, lifetimeFossil);
  const gasAnnualCapex= gasCapexTotal* crfGas;
  const gasAnnualFixedOM= gasCapMW* gasFixedOM;
  const gasFuelCost= (totalGas/ gasEff)* gasFuel;
  const gasVarCost= totalGas* gasVarOM;
  const gasAnnualCost= gasAnnualCapex+ gasAnnualFixedOM+ gasFuelCost+ gasVarCost;

  const solarCapexTotal= solarCapMW*1000* solarCapex;
  const crfSolar= CRF(waccRenew, lifetimeSolar);
  const solarAnnualCapex= solarCapexTotal* crfSolar;
  const solarAnnualFixedOM= solarCapMW* solarFixedOM;
  const solarAnnualCost= solarAnnualCapex+ solarAnnualFixedOM;

  const batteryCapexTotal= batteryCapMWh*1000* batteryCapex;
  const crfBattery= CRF(waccRenew, 25);
  const batteryAnnualCapex= batteryCapexTotal* crfBattery;
  const batteryMW= batteryCapMWh/4;
  const batteryAnnualFixedOM= batteryMW* batteryFixedOM;
  const batteryAnnualCost= batteryAnnualCapex+ batteryAnnualFixedOM;

  const gasLcoe= (totalGas>0)? gasAnnualCost/ totalGas:0;
  const solarLcoe= (totalSolarUsed>0)? solarAnnualCost/ totalSolarUsed:0;
  const batteryLcoe= (totalBattery>0)? batteryAnnualCost/ totalBattery:0;

  const totalAnnualCost= gasAnnualCost+ solarAnnualCost+ batteryAnnualCost;
  const systemLcoe= totalAnnualCost/ totalDemand;

  renderMixChart(totalGas, totalSolarUsed, totalBattery);
  renderLcoeChart(
    (gasAnnualCapex/ totalGas)||0,
    ((gasAnnualFixedOM+ gasFuelCost+ gasVarCost)/ totalGas)||0,
    (solarAnnualCapex/ totalSolarUsed)||0,
    (solarAnnualFixedOM/ totalSolarUsed)||0,
    (batteryAnnualCapex/ totalBattery)||0,
    (batteryAnnualFixedOM/ totalBattery)||0,
    systemLcoe
  );
  renderYearChart(allSolar, batteryIn, batteryOut, gasOut);
  renderJanChart(allSolar, batteryIn, batteryOut, gasOut);
  renderJulChart(allSolar, batteryIn, batteryOut, gasOut);
}

function sum(arr){ return arr.reduce((a,b)=>a+b,0); }
function CRF(r,n){
  if(r===0)return 1/n;
  const top= r* Math.pow(1+r,n);
  const bot= Math.pow(1+r,n)-1;
  return top/bot;
}

function renderMixChart(gasMWh, solarMWh, batteryMWh){
  if(annualMixChart) annualMixChart.destroy();
  const ctx= document.getElementById("annualMixChart").getContext("2d");
  annualMixChart= new Chart(ctx,{
    type:"bar",
    data:{
      labels:["Generation Mix"],
      datasets:[
        { label:"Gas", data:[gasMWh], backgroundColor:"#f45d5d", stack:"mix" },
        { label:"Solar", data:[solarMWh], backgroundColor:"#13ce74", stack:"mix" },
        { label:"Battery", data:[batteryMWh], backgroundColor:"#4db6e4", stack:"mix" }
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

function renderLcoeChart(
  gasCapex, gasOpex,
  solarCapex, solarOpex,
  batteryCapex, batteryOpex,
  systemLcoe
){
  if(lcoeChart) lcoeChart.destroy();
  const ctx= document.getElementById("lcoeChart").getContext("2d");
  lcoeChart= new Chart(ctx,{
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

function renderYearChart(solarFlow, batteryIn, batteryOut, gasFlow){
  if(yearlyProfileChart) yearlyProfileChart.destroy();
  const ctx= document.getElementById("yearlyProfileChart").getContext("2d");
  const HOURS=8760;
  const labels= [...Array(HOURS).keys()];

  yearlyProfileChart= new Chart(ctx,{
    type:"bar",
    data:{
      labels,
      datasets:[
        { label:"Battery In", data:batteryIn, backgroundColor:"#4db6e4", stack:"stack" },
        { label:"Solar (All)", data:solarFlow, backgroundColor:"#13ce74", stack:"stack" },
        { label:"Battery Out", data:batteryOut, backgroundColor:"rgba(77,182,228,0.5)", stack:"stack" },
        { label:"Gas", data:gasFlow, backgroundColor:"#f45d5d", stack:"stack" }
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

function renderJanChart(solarFlow, batteryIn, batteryOut, gasFlow){
  if(janProfileChart) janProfileChart.destroy();
  const ctx= document.getElementById("janProfileChart").getContext("2d");
  const janStart=0, janEnd=24*7;
  const labels= [...Array(janEnd-janStart).keys()];

  janProfileChart= new Chart(ctx,{
    type:"bar",
    data:{
      labels,
      datasets:[
        { label:"Battery In", data:batteryIn.slice(janStart, janEnd), backgroundColor:"#4db6e4", stack:"stack" },
        { label:"Solar (All)", data:solarFlow.slice(janStart, janEnd), backgroundColor:"#13ce74", stack:"stack" },
        { label:"Battery Out", data:batteryOut.slice(janStart, janEnd), backgroundColor:"rgba(77,182,228,0.5)", stack:"stack" },
        { label:"Gas", data:gasFlow.slice(janStart, janEnd), backgroundColor:"#f45d5d", stack:"stack" }
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

function renderJulChart(solarFlow, batteryIn, batteryOut, gasFlow){
  if(julProfileChart) julProfileChart.destroy();
  const ctx= document.getElementById("julProfileChart").getContext("2d");
  const julStart=4344;
  const julEnd=julStart+ (24*7);
  const labels= [...Array(julEnd- julStart).keys()];

  julProfileChart= new Chart(ctx,{
    type:"bar",
    data:{
      labels,
      datasets:[
        { label:"Battery In", data:batteryIn.slice(julStart,julEnd), backgroundColor:"#4db6e4", stack:"stack" },
        { label:"Solar (All)", data:solarFlow.slice(julStart,julEnd), backgroundColor:"#13ce74", stack:"stack" },
        { label:"Battery Out", data:batteryOut.slice(julStart,julEnd), backgroundColor:"rgba(77,182,228,0.5)", stack:"stack" },
        { label:"Gas", data:gasFlow.slice(julStart,julEnd), backgroundColor:"#f45d5d", stack:"stack" }
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
