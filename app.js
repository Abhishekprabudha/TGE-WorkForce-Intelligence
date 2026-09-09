const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const COLORS = {
  ink: '#0d201d', muted:'#687872', green:'#2f8b2e', bright:'#7edb3f', teal:'#0ea5a6', line:'#d9e1dc', risk:'#c9564f', amber:'#d99b24', pale:'#dff3f5'
};

const state = {
  view: 'overview', guided: false, guidedStep: 0,
  scenario: { demand: 0, absences: 0, linehaul: 0 },
  approved: new Set(), rejected: new Set()
};

const data = {
  site: 'Sydney West Depot', date: 'Thursday, 17 Sep', forecastItems: 18420, normalDeltaPct: 12.4,
  forecastConfidencePct: 93, currentLabourHours: 142, requiredLabourHours: 131,
  overtimeAtRiskHours: 7.5, serviceConfidencePct: 98.4, dailyOpportunityAud: 1860,
  validated30DayAud: 73400, annualisedAud: 881000,
  history: [11100,11500,12800,13350,12400,11800,11250,10700,11050,12450,13150,12900,12350,11600,10950,10750,11100,12400,13600,13900,13550,12100,11500,11950,13600,14200,15500,15000],
  forecast: [12850,13650,14750,15000,14500,13600,13100,13700,14700,16000,16550,16100,15150,14950],
  lower:    [12100,12800,13800,14100,13600,12600,12100,12650,13700,14950,15450,15000,14150,13750],
  upper:    [13600,14500,15700,16050,15500,14500,14100,14700,15750,17150,17700,17300,16450,16100],
  roster:   [23.6,24.4,25.6,26.8,27.8,28.7,29.4,29.4,29.4,29.8,30.0,29.8,29.0,27.8,26.4,25.2,24.3,23.5],
  required: [19.5,21.2,25.6,29.2,28.4,25.2,22.6,20.5,19.9,22.4,27.2,30.9,31.3,28.4,24.5,22.2,22.0,22.4],
  workforceHours: ['04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21'],
  actions: [
    { id:1, priority:'p1', title:'Move 4 cross-skilled staff from Inbound to Sortation at 14:45', desc:'Sortation is forecast to move above safe capacity from 15:00–17:00 while inbound demand falls away.', cost:690, service:'Backlog risk 18% → 4%', confidence:94, type:'Redeploy', backlog:610 },
    { id:2, priority:'p2', title:'Delay 2 agency starts from 05:00 to 06:30', desc:'Early inbound demand is below rostered capacity. Delaying two agency starts protects service while removing idle time.', cost:310, service:'No projected SLA impact', confidence:91, type:'Agency', backlog:0 },
    { id:3, priority:'p3', title:'Remove 7.5 planned overtime hours', desc:'Forecast workload and the redeployment plan leave adequate late-shift coverage without the currently planned overtime.', cost:860, service:'Service confidence remains 98.1%', confidence:89, type:'Overtime', backlog:0 }
  ],
  drivers: [
    ['Marketplace parcel uplift',5.8], ['Sydney–Melbourne lane',3.1], ['Thursday seasonal factor',2.4], ['Express-service mix',1.7], ['Other effects',-0.6]
  ],
  workload: [
    { name:'Inbound', volume:'4,830', units:'1,320', fte:'26.4', load:68 },
    { name:'Dock/Yard', volume:'17 moves', units:'940', fte:'18.2', load:54 },
    { name:'Sortation', volume:'11,860', units:'2,430', fte:'48.6', load:92 },
    { name:'Linehaul', volume:'7 dep.', units:'1,085', fte:'21.5', load:63 },
    { name:'Last mile', volume:'6,140', units:'830', fte:'16.3', load:49 }
  ]
};

const guidedSteps = [
  {view:'overview', title:'View tomorrow', copy:"Start with the operating picture, not yesterday's report.", button:'View Tomorrow'},
  {view:'forecast', title:'Explain the forecast', copy:'Show what is changing, when, and why.', button:'Why is demand changing?'},
  {view:'workload', title:'Translate to workload', copy:'Turn forecast volume into function-level effort.', button:'Translate to Workload'},
  {view:'workforce', title:'Compare roster to required', copy:'Show where labour and demand diverge by hour.', button:'Compare Roster'},
  {view:'actions', title:'Recommend actions', copy:'Rank the decisions with cost, service and confidence attached.', button:'Recommend Actions'},
  {view:'actions', title:'Simulate the top action', copy:'Test the operating impact before approving anything.', button:'Simulate Impact', special:'simulate'},
  {view:'scenarios', title:'Stress-test tomorrow', copy:'Show how the plan changes if demand or staffing moves.', button:'Stress Test'},
  {view:'actions', title:'Approve the recommendation', copy:'Keep the pilot human-controlled and read-only.', button:'Approve Recommendation', special:'approve'},
  {view:'value', title:'Track value', copy:'Tie decisions back to labour cost, service and annualised economics.', button:'Track Value'},
  {view:'scale', title:'Scale the pattern', copy:'Show how one validated site becomes a repeatable operating model.', button:'Scale This Pattern'}
];

function money(n){ return new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}).format(n); }
function num(n){ return new Intl.NumberFormat('en-AU').format(n); }
function setView(view){
  state.view = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const titles = {overview:"Tomorrow's depot", forecast:'Demand forecast', workload:'Workload translator', workforce:'Workforce plan', actions:'Action queue', scenarios:'Scenario simulator', value:'Value tracker', scale:'Scale pattern'};
  $('#pageTitle').textContent = titles[view];
  render();
}

function svgLineChart(seriesA, seriesB, lower, upper, opts={}){
  const W=820,H=310,p={l:46,r:18,t:18,b:34};
  const all=[...seriesA,...(seriesB||[]),...(lower||[]),...(upper||[])];
  const min=Math.min(...all), max=Math.max(...all); const pad=(max-min)*.08;
  const ymin=min-pad, ymax=max+pad;
  const x=i=>p.l+i*(W-p.l-p.r)/(Math.max(seriesA.length,(seriesB||[]).length)-1);
  const y=v=>p.t+(ymax-v)*(H-p.t-p.b)/(ymax-ymin);
  const line=(arr,offset=0)=>arr.map((v,i)=>`${i?'L':'M'} ${x(i+offset).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  let grid=''; for(let i=0;i<5;i++){ const yy=p.t+i*(H-p.t-p.b)/4; const val=ymax-i*(ymax-ymin)/4; grid+=`<line x1="${p.l}" x2="${W-p.r}" y1="${yy}" y2="${yy}" stroke="#e5eae7"/><text x="${p.l-8}" y="${yy+4}" text-anchor="end" font-size="10" fill="#7a8984">${Math.round(val).toLocaleString()}</text>`; }
  let band='';
  if(lower&&upper){ const off=seriesA.length-1; const pts1=upper.map((v,i)=>`${x(i+off)},${y(v)}`).join(' '); const pts2=[...lower].reverse().map((v,ri)=>{const i=lower.length-1-ri; return `${x(i+off)},${y(v)}`}).join(' '); band=`<polygon points="${pts1} ${pts2}" fill="#dff3f5" opacity=".95"/>`; }
  const divider = seriesB ? `<line x1="${x(seriesA.length-1)}" x2="${x(seriesA.length-1)}" y1="${p.t}" y2="${H-p.b}" stroke="#9eb0aa" stroke-dasharray="5 5"/><text x="${x(seriesA.length-1)+8}" y="${p.t+15}" font-size="10" fill="#0ea5a6" font-weight="700">prediction window</text>`:'';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.aria||'Forecast chart'}">
    ${grid}${band}${divider}
    <path d="${line(seriesA)}" fill="none" stroke="${COLORS.bright}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    ${seriesB?`<path d="${line(seriesB,seriesA.length-1)}" fill="none" stroke="${COLORS.teal}" stroke-width="3.2" stroke-dasharray="8 6" stroke-linecap="round" stroke-linejoin="round"/>`:''}
    <line x1="${p.l}" x2="${W-p.r}" y1="${H-p.b}" y2="${H-p.b}" stroke="#bcc8c3"/>
    <text x="${W/2}" y="${H-8}" text-anchor="middle" font-size="10" fill="#7a8984">operating days</text>
  </svg>`;
}

function svgWorkforce(){
  const A=data.roster,B=data.required,W=820,H=320,p={l:42,r:14,t:16,b:42}, ymin=18,ymax=33;
  const x=i=>p.l+i*(W-p.l-p.r)/(A.length-1), y=v=>p.t+(ymax-v)*(H-p.t-p.b)/(ymax-ymin);
  let grid=''; for(let v=20;v<=32;v+=2){ const yy=y(v); grid+=`<line x1="${p.l}" x2="${W-p.r}" y1="${yy}" y2="${yy}" stroke="#e5eae7"/><text x="${p.l-7}" y="${yy+3}" text-anchor="end" font-size="9.5" fill="#7a8984">${v}</text>`; }
  const line=arr=>arr.map((v,i)=>`${i?'L':'M'} ${x(i)} ${y(v)}`).join(' ');
  let areas='';
  for(let i=0;i<A.length-1;i++){
    const over=(A[i]+A[i+1])>(B[i]+B[i+1]);
    areas += `<polygon points="${x(i)},${y(A[i])} ${x(i+1)},${y(A[i+1])} ${x(i+1)},${y(B[i+1])} ${x(i)},${y(B[i])}" fill="${over?'#dff3f5':'#fde9e7'}" opacity=".95"/>`;
  }
  let labels=''; data.workforceHours.forEach((h,i)=>{ if(i%2===0) labels+=`<text x="${x(i)}" y="${H-18}" text-anchor="middle" font-size="9.5" fill="#7a8984">${h}:00</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Current roster compared to AI-required workforce by hour">${grid}${areas}
    <path d="${line(A)}" fill="none" stroke="#536a64" stroke-width="3"/><path d="${line(B)}" fill="none" stroke="${COLORS.bright}" stroke-width="3.2"/>
    ${labels}<text x="12" y="${H/2}" transform="rotate(-90 12 ${H/2})" text-anchor="middle" font-size="10" fill="#7a8984">FTE needed</text>
  </svg>`;
}

function renderOverview(){
  return `<div class="page">
    <div class="hero-card">
      <div>
        <div class="hero-title">Tomorrow · ${data.site}</div>
        <div class="hero-value">${num(data.forecastItems)} items <span class="up">+${data.normalDeltaPct}%</span></div>
        <div class="hero-copy">Demand is expected to peak across inbound and sortation before midday. The current roster is service-safe overall, but three decisions can reduce avoidable labour cost and protect the afternoon sort window.</div>
        <div class="hero-actions">
          <button class="btn primary" data-go="forecast">Why is demand changing?</button>
          <button class="btn secondary" data-go="workforce">Compare roster vs required</button>
          <button class="btn green" data-go="actions">Review 3 actions</button>
        </div>
      </div>
      <div class="hero-side">
        <div><div class="caption">Decisions requiring attention</div><div class="decision-num">3</div></div>
        <div><strong>Resolve before 17:00 today</strong><div class="caption" style="margin-top:4px">1 redeployment · 1 agency timing · 1 overtime decision</div></div>
      </div>
    </div>

    <div class="kpi-grid">
      ${kpi('Forecast confidence',data.forecastConfidencePct+'%','Quantile band · planner view')}
      ${kpi('Current roster',data.currentLabourHours+' hrs','Planned labour hours')}
      ${kpi('Required labour',data.requiredLabourHours+' hrs','Demand-led estimate','good','11 hrs below roster')}
      ${kpi('Overtime at risk',data.overtimeAtRiskHours+' hrs','Currently planned','warn','Avoidable if actions approved')}
      ${kpi('Service confidence',data.serviceConfidencePct+'%','After recommended actions','good','Held within guardrail')}
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Tomorrow's operating shape</h2><div class="panel-sub">Observed history transitions into the forecast window.</div></div><button class="mini-btn" data-go="forecast">Open forecast</button></div>
        <div class="chart-wrap">${svgLineChart(data.history,data.forecast,data.lower,data.upper)}</div>
        <div class="chart-legend"><span class="legend-item"><i class="legend-swatch green"></i>Observed</span><span class="legend-item"><i class="legend-swatch teal"></i>Forecast</span><span class="legend-item"><i class="legend-box"></i>Confidence band</span></div>
      </div>
      <div class="panel dark">
        <div class="panel-title-row"><div><h2>Top operating decision</h2><div class="panel-sub">Highest value / service priority</div></div><span class="pill risk">Priority 1</span></div>
        <h3 style="font-size:17px;line-height:1.35">Move 4 cross-skilled staff from Inbound to Sortation at 14:45</h3>
        <div class="metric-list" style="margin-top:20px">
          <div class="metric-row"><span>Backlog avoided</span><strong>610 items</strong></div>
          <div class="metric-row"><span>Overtime avoided</span><strong>${money(690)}</strong></div>
          <div class="metric-row"><span>Model confidence</span><strong>94%</strong></div>
        </div>
        <button class="btn green" style="margin-top:20px;width:100%" onclick="openAction(1)">Review recommendation</button>
      </div>
    </div>
  </div>`;
}

function kpi(label,value,sub,cls='',delta=''){ return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub ${cls?'kpi-delta '+cls:''}">${delta||sub}</div>${delta?`<div class="kpi-sub">${sub}</div>`:''}</div>`; }

function renderForecast(){
  return `<div class="page">
    <div class="callout"><div><strong>Prediction before action</strong><span> · Forecast daily and shift-level demand, then explain what moved it.</span></div><button class="btn primary" data-go="workload">Translate to workload →</button></div>
    <div class="two-col">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Depot demand forecast</h2><div class="panel-sub">Daily site volume before it reaches the floor.</div></div><span class="pill good">${data.forecastConfidencePct}% confidence</span></div>
        <div class="chart-wrap">${svgLineChart(data.history,data.forecast,data.lower,data.upper)}</div>
        <div class="chart-legend"><span class="legend-item"><i class="legend-swatch green"></i>Observed depot volume</span><span class="legend-item"><i class="legend-swatch teal"></i>Forecast demand</span><span class="legend-item"><i class="legend-box"></i>Confidence band</span></div>
      </div>
      <div class="panel">
        <div class="panel-title-row"><div><h2>Why tomorrow is +${data.normalDeltaPct}%</h2><div class="panel-sub">Contribution to forecast vs typical Thursday.</div></div></div>
        <div class="driver-list">
          ${data.drivers.map(d=>`<div class="driver-row"><span class="driver-label">${d[0]}</span><span class="driver-val ${d[1]<0?'kpi-delta risk':'kpi-delta good'}">${d[1]>0?'+':''}${d[1]}%</span><div class="driver-bar"><span style="width:${Math.abs(d[1])/6*100}%;background:${d[1]<0?'#c9564f':'#7edb3f'}"></span></div></div>`).join('')}
        </div>
        <div class="callout" style="margin-top:18px"><div><strong>Peak window</strong><span> · 08:00–11:00 sortation</span></div><strong>High</strong></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>What gets predicted</h2><div class="panel-sub">The forecast is more than a parcel count.</div></div></div>
      <div class="workload-grid">
        ${[['Daily + shift volume','Volume'],['Arrival waves + peaks','Timing'],['Freight mix + priority','Complexity'],['Handoff / backing risk','Risk'],['Confidence bands','Uncertainty']].map(([a,b])=>`<div class="workload-card"><div class="name">${a}</div><div class="tiny">${b}</div></div>`).join('')}
      </div>
    </div>
  </div>`;
}

function renderWorkload(){
  return `<div class="page">
    <div class="callout"><div><strong>${num(data.forecastItems)} items ≠ ${num(data.forecastItems)} identical units of work</strong><span> · Translate mix, arrival pattern and service commitment into function-level effort.</span></div><button class="btn primary" data-go="workforce">Compare roster →</button></div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Workload translator</h2><div class="panel-sub">Required work = Volume × Mix × Process complexity × Arrival wave × Service commitment × Site coefficient.</div></div><span class="pill good">Tomorrow</span></div>
      <div class="workload-grid">
        ${data.workload.map(w=>`<div class="workload-card"><div class="name">${w.name}</div><div class="big">${w.fte} hrs</div><div class="tiny">${w.volume} · ${w.units} weighted units</div><div class="workload-bar"><span style="width:${w.load}%"></span></div></div>`).join('')}
      </div>
    </div>
    <div class="split-equal">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Workload coefficients</h2><div class="panel-sub">Synthetic values for the demo; replace with TGE site history during the pilot.</div></div></div>
        <table class="table"><thead><tr><th>Function</th><th>Site coefficient</th><th>Peak period</th><th>Signal</th></tr></thead><tbody>
          <tr><td>Inbound</td><td>0.96</td><td>07:00–10:00</td><td><span class="pill good">Normal</span></td></tr>
          <tr><td>Dock/Yard</td><td>1.08</td><td>13:00–16:00</td><td><span class="pill warn">Elevated</span></td></tr>
          <tr><td>Sortation</td><td>1.13</td><td>08:00–11:00</td><td><span class="pill risk">Constraint</span></td></tr>
          <tr><td>Linehaul</td><td>0.92</td><td>16:00–19:00</td><td><span class="pill good">Normal</span></td></tr>
        </tbody></table>
      </div>
      <div class="panel dark">
        <h2>Operational meaning</h2><div class="panel-sub">The same demand can require different labour depending on when it arrives and what work it creates.</div>
        <div class="metric-list" style="margin-top:22px"><div class="metric-row"><span>Highest workload concentration</span><strong>Sortation</strong></div><div class="metric-row"><span>Peak requirement</span><strong>48.6 hrs</strong></div><div class="metric-row"><span>Earliest action window</span><strong>Today 17:00</strong></div></div>
      </div>
    </div>
  </div>`;
}

function renderWorkforce(){
  return `<div class="page">
    <div class="two-col">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Workforce requirement by hour</h2><div class="panel-sub">Where current roster and demand-led requirement diverge.</div></div><button class="btn primary" data-go="actions">Recommend actions →</button></div>
        <div class="chart-wrap">${svgWorkforce()}</div>
        <div class="chart-legend"><span class="legend-item"><i class="legend-swatch" style="background:#536a64"></i>Current roster</span><span class="legend-item"><i class="legend-swatch green"></i>AI-required workforce</span><span class="legend-item"><i class="legend-box"></i>Overstaffing</span><span class="legend-item"><i class="legend-box risk"></i>Understaffing risk</span></div>
      </div>
      <div class="panel dark">
        <div class="panel-title-row"><div><h2>Managed decisions</h2><div class="panel-sub">What the depot manager can change.</div></div></div>
        <div class="metric-list" style="margin-top:18px">
          ${['Shift sizing by role / function','Cross-skill redeployment','Overtime and agency control','Break and handoff coverage','Supervisor action queue'].map(x=>`<div class="metric-row"><span>${x}</span><strong style="color:var(--green)">→</strong></div>`).join('')}
        </div>
        <div class="callout" style="margin-top:22px;background:#16312c;border-color:#2c5149;color:white"><div><strong>Manager value</strong><span style="color:#a8bbb5"> · who to move, when, why, and what risk changes.</span></div></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Exception windows</h2><div class="panel-sub">These are the periods worth discussing in the room.</div></div></div>
      <table class="table"><thead><tr><th>Window</th><th>Function</th><th>Gap</th><th>Likely effect</th><th>Decision</th></tr></thead><tbody>
        <tr><td>05:00–07:00</td><td>Inbound</td><td>+4.3 FTE</td><td>Idle / agency cost</td><td><span class="pill good">Delay starts</span></td></tr>
        <tr><td>10:00–14:00</td><td>Inbound</td><td>+7.8 FTE</td><td>Redeployment pool</td><td><span class="pill good">Cross-skill</span></td></tr>
        <tr><td>15:00–17:00</td><td>Sortation</td><td>-3.7 FTE</td><td>610-item backlog risk</td><td><span class="pill risk">Move 4 staff</span></td></tr>
        <tr><td>19:00–21:00</td><td>Late shift</td><td>-0.4 FTE</td><td>Low service risk</td><td><span class="pill warn">Monitor</span></td></tr>
      </tbody></table>
    </div>
  </div>`;
}

function renderActions(){
  return `<div class="page">
    <div class="callout"><div><strong>3 decisions require attention before 17:00</strong><span> · ranked by service risk, economic value and confidence.</span></div><button class="btn secondary" onclick="openSim()">Compare alternatives</button></div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Supervisor action queue</h2><div class="panel-sub">Every recommendation shows why, action, cost impact, service impact and confidence.</div></div></div>
      <div class="action-list">${data.actions.map(actionCard).join('')}</div>
    </div>
    <div class="split-equal">
      <div class="panel dark"><h2>Human-in-loop by design</h2><div class="panel-sub">The demo never writes to the roster. Approval records intent for planner review only.</div><div class="metric-list" style="margin-top:18px"><div class="metric-row"><span>Approved</span><strong id="approvedCount">${state.approved.size}</strong></div><div class="metric-row"><span>Rejected</span><strong>${state.rejected.size}</strong></div><div class="metric-row"><span>Pending</span><strong>${3-state.approved.size-state.rejected.size}</strong></div></div></div>
      <div class="panel"><h2>Decision rule</h2><div class="panel-sub">Minimise labour cost + overtime + backlog risk, subject to SLA, safety, role and break constraints.</div><div class="callout" style="margin-top:18px"><div><strong>No autonomous roster change</strong><span> · until TGE chooses to progress beyond pilot mode.</span></div></div></div>
    </div>
  </div>`;
}

function actionCard(a){
  const status = state.approved.has(a.id)?'<span class="pill good">Approved</span>':state.rejected.has(a.id)?'<span class="pill risk">Rejected</span>':'';
  return `<div class="action-card"><div class="priority ${a.priority}">${a.id}</div><div><strong>${a.title}</strong><p>${a.desc}</p><div class="action-meta"><span>Saving <b>${money(a.cost)}</b></span><span>Service <b>${a.service}</b></span><span>Confidence <b>${a.confidence}%</b></span>${status}</div></div><div class="action-buttons"><button class="mini-btn" onclick="openAction(${a.id})">Review</button><button class="mini-btn primary" onclick="openSim(${a.id})">Simulate</button></div></div>`;
}

function renderScenarios(){
  const effect = scenarioEffect();
  return `<div class="page">
    <div class="panel">
      <div class="panel-title-row"><div><h2>Stress-test tomorrow</h2><div class="panel-sub">Change one assumption and the workforce plan recomputes instantly.</div></div><button class="btn secondary" onclick="resetScenario()">Reset scenario</button></div>
      <div class="scenario-toolbar"><button class="scenario-chip" onclick="presetScenario('demand')">Demand +15%</button><button class="scenario-chip" onclick="presetScenario('absence')">6 absences</button><button class="scenario-chip" onclick="presetScenario('late')">Linehaul +90 min</button></div>
      <div class="range-row"><label>Demand variance</label><input id="demandRange" type="range" min="-15" max="25" step="1" value="${state.scenario.demand}" oninput="updateScenario('demand',this.value)"><div class="range-value">${state.scenario.demand>0?'+':''}${state.scenario.demand}%</div></div>
      <div class="range-row"><label>Unplanned absences</label><input id="absenceRange" type="range" min="0" max="12" step="1" value="${state.scenario.absences}" oninput="updateScenario('absences',this.value)"><div class="range-value">${state.scenario.absences}</div></div>
      <div class="range-row"><label>Linehaul delay</label><input id="lateRange" type="range" min="0" max="180" step="15" value="${state.scenario.linehaul}" oninput="updateScenario('linehaul',this.value)"><div class="range-value">${state.scenario.linehaul} min</div></div>
    </div>
    <div class="kpi-grid">
      ${kpi('Forecast volume',num(effect.volume),'Scenario-adjusted')}
      ${kpi('Required labour',effect.required.toFixed(0)+' hrs','Recomputed','warn',effect.required>data.requiredLabourHours?`+${(effect.required-data.requiredLabourHours).toFixed(0)} hrs vs base`:`${(effect.required-data.requiredLabourHours).toFixed(0)} hrs vs base`)}
      ${kpi('Overtime exposure',effect.overtime.toFixed(1)+' hrs','If roster unchanged',effect.overtime>10?'risk':'warn')}
      ${kpi('Service confidence',effect.service.toFixed(1)+'%','If no action taken',effect.service<95?'risk':'good')}
      ${kpi('Estimated cost exposure',money(effect.cost),'Avoidable / recoverable')}
    </div>
    <div class="split-equal">
      <div class="panel"><h2>Recomputed recommendation</h2><div class="panel-sub">The action changes with the scenario.</div><div class="callout" style="margin-top:18px"><div><strong>${effect.recommendation}</strong><span> · ${effect.reason}</span></div></div></div>
      <div class="panel dark"><h2>Why this matters</h2><div class="panel-sub">This is where the client sees the application respond to uncertainty rather than replaying a fixed dashboard.</div><button class="btn green" style="margin-top:18px" onclick="openSim()">Compare response options</button></div>
    </div>
  </div>`;
}

function scenarioEffect(){
  const {demand,absences,linehaul}=state.scenario;
  const volume=Math.round(data.forecastItems*(1+demand/100));
  const required=data.requiredLabourHours*(1+demand/100)+absences*7.5+linehaul/90*4;
  const overtime=Math.max(0, data.overtimeAtRiskHours + demand*.35 + absences*.8 + linehaul/45*1.5);
  const service=Math.max(82, data.serviceConfidencePct - Math.max(0,demand)*.18 - absences*.45 - linehaul/60*.7);
  const cost=Math.round(1860 + Math.max(0,demand)*90 + absences*145 + linehaul*8);
  let recommendation='Keep base plan'; let reason='Current coverage remains inside the service guardrail.';
  if(absences>=5){ recommendation='Add 2 agency staff and redeploy 4 cross-skilled staff'; reason='Absence pressure creates a sustained sortation gap.'; }
  else if(demand>=12){ recommendation='Bring forward 4 sort staff and retain 4.0 overtime hours'; reason='Higher demand pushes the peak above the base capacity envelope.'; }
  else if(linehaul>=60){ recommendation='Advance staging crew by 30 minutes'; reason='Late linehaul shifts work into the final dispatch window.'; }
  return {volume,required,overtime,service,cost,recommendation,reason};
}

function renderValue(){
  return `<div class="page">
    <div class="value-hero">
      <div class="value-big"><div class="label">Validated demo opportunity · 30 days</div><div class="num">${money(data.validated30DayAud)}</div><div class="sub">Synthetic values for demonstration. Replace with TGE site economics in the pilot.</div></div>
      <div class="panel"><div class="panel-title-row"><div><h2>Value by lever</h2><div class="panel-sub">Operational improvements roll into one economic anchor: labour cost per unit of throughput.</div></div></div><div class="value-bars">
        ${[['Overtime avoided',84,'$24.1k'],['Agency optimised',72,'$18.3k'],['Idle time reduced',64,'$16.8k'],['Backlog risk avoided',55,'$14.2k']].map(x=>`<div class="value-bar-row"><span>${x[0]}</span><div class="value-track"><span style="width:${x[1]}%"></span></div><strong>${x[2]}</strong></div>`).join('')}
      </div></div>
    </div>
    <div class="kpi-grid">
      ${kpi('Labour cost / item','AUD 0.77','Demo after actions','good','from AUD 0.84')}
      ${kpi('Items / labour-hour','46.1','Productivity','good','from 42.3')}
      ${kpi('Overtime','326 hrs','30-day demo','good','from 412 hrs')}
      ${kpi('Agency usage','1,105 hrs','30-day demo','good','from 1,240 hrs')}
      ${kpi('Service level','98.3%','Held constant','good','from 98.2%')}
    </div>
    <div class="two-col"><div class="panel"><h2>Economic proof</h2><div class="panel-sub">Daily recommendation → validated action → realised saving → annualised opportunity.</div><div class="callout" style="margin-top:18px"><div><strong>Annualised run-rate</strong><span> · once TGE economics are validated</span></div><strong>${money(data.annualisedAud)}</strong></div></div><div class="panel dark"><h2>What the client should take away</h2><div class="panel-sub">Model accuracy matters, but the pilot is successful only if it changes a staffing decision and produces measurable site economics without harming service.</div></div></div>
  </div>`;
}

function renderScale(){
  return `<div class="page">
    <div class="hero-card"><div><div class="hero-title">Scale only after the operating pattern proves itself</div><div class="hero-value" style="font-size:34px">One site → one cluster → network template</div><div class="hero-copy">The first proof establishes data quality, decision trust and economic repeatability. Scaling then becomes a controlled replication exercise, not an enterprise-wide leap.</div><button class="btn primary" data-go="overview">Return to tomorrow's depot</button></div><div class="hero-side"><div><div class="caption">First proof</div><div class="decision-num">6–8</div><strong>weeks to a go / no-go decision</strong></div><div class="caption">Read-only first · measured value at every step</div></div></div>
    <div class="scale-steps">
      <div class="scale-card"><div class="step">01 · PROVE</div><div class="site">1 site</div><p>Validate signals, workload coefficients, roster actions and KPI movement.</p></div>
      <div class="scale-card"><div class="step">02 · REPEAT</div><div class="site">5 sites</div><p>Test portability across different demand shapes and labour profiles.</p></div>
      <div class="scale-card"><div class="step">03 · CLUSTER</div><div class="site">25 sites</div><p>Standardise templates, thresholds, role rules and operational governance.</p></div>
      <div class="scale-card"><div class="step">04 · NETWORK</div><div class="site">650+</div><p>Scale a proven decision pattern with local coefficients and site guardrails.</p></div>
    </div>
    <div class="two-col"><div class="panel"><h2>What TGE provides for the pilot</h2><table class="table"><tbody><tr><td>Select medium-sized site</td><td><span class="pill good">Required</span></td></tr><tr><td>Nominate Ops + IT/data owners</td><td><span class="pill good">Required</span></td></tr><tr><td>Share 6–12 months of site data</td><td><span class="pill good">Required</span></td></tr><tr><td>Agree KPI contract</td><td><span class="pill good">Required</span></td></tr><tr><td>Weekly value reviews</td><td><span class="pill good">Required</span></td></tr></tbody></table></div><div class="panel dark"><h2>Outcome for TGE</h2><div class="panel-sub">A proven, repeatable operating model that can scale network-wide.</div><div class="metric-list" style="margin-top:20px"><div class="metric-row"><span>Faster site activation</span><strong>→</strong></div><div class="metric-row"><span>Lower operating cost</span><strong>→</strong></div><div class="metric-row"><span>Higher service reliability</span><strong>→</strong></div><div class="metric-row"><span>Scalable national pattern</span><strong>→</strong></div></div></div></div>
  </div>`;
}

function render(){
  const map={overview:renderOverview,forecast:renderForecast,workload:renderWorkload,workforce:renderWorkforce,actions:renderActions,scenarios:renderScenarios,value:renderValue,scale:renderScale};
  $('#appContent').innerHTML = map[state.view]();
  $$('[data-go]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.go)));
}

window.openAction = function(id){
  const a=data.actions.find(x=>x.id===id); const dlg=$('#actionDialog');
  dlg.innerHTML=`<div class="dialog-inner"><div class="dialog-header"><div><h2>${a.type} recommendation</h2><p>${a.title}</p></div><button class="dialog-close" onclick="document.getElementById('actionDialog').close()">×</button></div><div class="dialog-grid"><div class="dialog-stat"><span>Estimated saving</span><strong>${money(a.cost)}</strong></div><div class="dialog-stat"><span>Service effect</span><strong style="font-size:13px">${a.service}</strong></div><div class="dialog-stat"><span>Confidence</span><strong>${a.confidence}%</strong></div></div><div class="panel-sub" style="font-size:12px">${a.desc}</div><div class="callout" style="margin-top:16px"><div><strong>Why now</strong><span> · decision should be made before the shift is locked.</span></div></div><div class="dialog-actions"><button class="btn secondary" onclick="rejectAction(${id})">Reject</button><button class="btn secondary" onclick="openSim(${id})">Simulate impact</button><button class="btn green" onclick="approveAction(${id})">Approve for planner review</button></div></div>`;
  dlg.showModal();
}
window.approveAction=function(id){ state.approved.add(id); state.rejected.delete(id); const d=$('#actionDialog'); if(d.open) d.close(); toast('Recommendation approved for planner review — no write-back performed.'); render(); }
window.rejectAction=function(id){ state.rejected.add(id); state.approved.delete(id); const d=$('#actionDialog'); if(d.open) d.close(); toast('Recommendation rejected. The decision is recorded for model feedback.'); render(); }
window.openSim=function(id=1){
  const a=data.actions.find(x=>x.id===id)||data.actions[0], dlg=$('#simDialog');
  dlg.innerHTML=`<div class="dialog-inner"><div class="dialog-header"><div><h2>Simulate before approving</h2><p>${a.title}</p></div><button class="dialog-close" onclick="document.getElementById('simDialog').close()">×</button></div><div class="dialog-grid"><div class="dialog-stat"><span>Backlog risk</span><strong>18% → 4%</strong></div><div class="dialog-stat"><span>Overtime</span><strong>14.5 → 4.2 hrs</strong></div><div class="dialog-stat"><span>Service confidence</span><strong>96.9 → 98.4%</strong></div></div><h3 style="margin:18px 0 10px">Compare alternatives</h3><div class="option-grid"><div class="option-card best"><h4>A · Redeploy 4 staff</h4><p>No extra labour cost. Uses cross-skilled inbound capacity before the sort peak.</p><div class="option-metric">Best cost / service trade-off</div></div><div class="option-card"><h4>B · Add agency labour</h4><p>Protects service but adds external labour cost and requires lead time.</p><div class="option-metric">+${money(420)} cost</div></div><div class="option-card"><h4>C · Keep overtime</h4><p>Requires no move now, but leaves overtime locked into the late shift.</p><div class="option-metric">+${money(690)} vs A</div></div></div><div class="dialog-actions"><button class="btn secondary" onclick="document.getElementById('simDialog').close()">Close</button><button class="btn green" onclick="document.getElementById('simDialog').close(); approveAction(${a.id})">Approve option A</button></div></div>`; dlg.showModal();
}

window.updateScenario=function(k,v){ state.scenario[k]=Number(v); render(); }
window.resetScenario=function(){ state.scenario={demand:0,absences:0,linehaul:0}; render(); }
window.presetScenario=function(kind){ if(kind==='demand')state.scenario={demand:15,absences:0,linehaul:0}; if(kind==='absence')state.scenario={demand:0,absences:6,linehaul:0}; if(kind==='late')state.scenario={demand:0,absences:0,linehaul:90}; render(); }

function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.remove('show'),2600); }

function updateGuided(){
  const s=guidedSteps[state.guidedStep]; $('#guidedStepNo').textContent=state.guidedStep+1; $('#guidedTitle').textContent=s.title; $('#guidedCopy').textContent=s.copy; $('#guidedAction').textContent=s.button; setView(s.view);
}
$('#guidedBtn').addEventListener('click',()=>{ state.guided=true; state.guidedStep=0; $('#guidedStrip').classList.remove('hidden'); updateGuided(); });
$('#closeGuided').addEventListener('click',()=>{ state.guided=false; $('#guidedStrip').classList.add('hidden'); });
$('#guidedAction').addEventListener('click',()=>{
  const s=guidedSteps[state.guidedStep]; if(s.special==='simulate') openSim(1); if(s.special==='approve') approveAction(1);
  if(state.guidedStep<guidedSteps.length-1){ state.guidedStep++; setTimeout(updateGuided, s.special?250:0); } else { state.guided=false; $('#guidedStrip').classList.add('hidden'); toast('Guided demo complete.'); }
});
$('#resetBtn').addEventListener('click',()=>{ state.view='overview';state.guided=false;state.guidedStep=0;state.scenario={demand:0,absences:0,linehaul:0};state.approved.clear();state.rejected.clear();$('#guidedStrip').classList.add('hidden');setView('overview');toast('Demo reset.'); });
$$('.nav-item').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));

render();
