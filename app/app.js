/* RE+ 2026 Dining Holds — front end. Plain JS, no build step. */
(function(){
  "use strict";
  const DAYS = ["2026-11-16","2026-11-17","2026-11-18","2026-11-19"];
  const ACTIVE = new Set(["Hold","Confirmed"]);
  const state = { res: [], nearby: [], areas: [], loaded:false, nearLoaded:false, isOwner:false, db:null, downloads:null,
    tab:"nearby", nearMode:"Breakfast", openAreas:new Set(), f:{host:"",status:"",day:""}, nearF:"", nearMax:"", sort:{key:"date",dir:1}, editing:null, confirmDel:null, err:"" };

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const safeUrl = u => /^https?:\/\//i.test(u||"") ? u : "";

  function dayLabel(d){
    if(!d) return "No date";
    const dt = new Date(d+"T12:00:00");
    return dt.toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"});
  }
  function shortDay(d){ if(!d) return "—"; return new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"numeric",day:"numeric"}); }
  function fmtTime(t){
    if(!t) return "—";
    const [h,m] = t.split(":").map(Number); const ap = h>=12?"pm":"am"; const hh = ((h+11)%12)+1;
    return hh+":"+String(m).padStart(2,"0")+" "+ap;
  }
  function mins(t){ if(!t) return null; const [h,m]=t.split(":").map(Number); return h*60+m; }
  /* Time to leave the booth so the party is seated on time */
  function leaveBy(r){
    const t = mins(r.time), tr = Number(r.travel);
    if(t==null || !tr) return "";
    const m = ((t - tr) % 1440 + 1440) % 1440;
    return fmtTime(String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0"));
  }
  function fmtDeadline(s){
    if(!s) return "";
    const d = new Date(s); if(isNaN(d)) return s;
    return d.toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
  }

  /* Attention flags: release deadlines and host double-bookings */
  function flagsFor(r){
    const out = [];
    if(!ACTIVE.has(r.status)) return out;
    if(r.cancelBy){
      const diff = new Date(r.cancelBy) - Date.now();
      if(!isNaN(diff)){
        if(diff < 0 && r.status==="Hold") out.push({lvl:"bad", text:"Cancel-by deadline passed ("+fmtDeadline(r.cancelBy)+") — fees may now apply"});
        else if(diff >= 0 && diff < 48*3600e3) out.push({lvl:"warn", text:"Release decision due in "+Math.max(1,Math.round(diff/3600e3))+" h ("+fmtDeadline(r.cancelBy)+")"});
      }
    }
    const ar = state.areas.find(a=>a.id===r.area);
    if(r.date && r.date>="2026-11-19" && r.date<="2026-11-21" && (mins(r.time)??0) >= 12*60 && (!ar || ar.f1Risk)){
      out.push({lvl:"warn", text:"F1 race day: Strip closures likely from early afternoon. Take the Monorail or Vegas Loop, or add 20+ min"+(ar?"":" (set an Area to check)")});
    }
    const t = mins(r.time), host = (r.host||"").trim().toLowerCase();
    if(t!=null && host){
      for(const o of state.res){
        if(o.id===r.id || !ACTIVE.has(o.status) || o.date!==r.date) continue;
        if((o.host||"").trim().toLowerCase()!==host) continue;
        const ot = mins(o.time); if(ot==null) continue;
        const buffer = 90 + Math.max(Number(r.travel)||0, Number(o.travel)||0);
        if(Math.abs(ot - t) < buffer) out.push({lvl:"bad", text:"Host conflict: "+(o.restaurant||"another booking")+" at "+fmtTime(o.time)});
      }
    }
    if(r.status==="Hold" && r.date){
      const daysOut = (new Date(r.date+"T00:00:00") - Date.now())/864e5;
      if(daysOut >= 0 && daysOut < 7 && !r.conf) out.push({lvl:"warn", text:"Still a hold with no confirmation # — under a week out"});
    }
    return out;
  }

  function filtered(){
    return state.res.filter(r =>
      (!state.f.host || (r.host||"")===state.f.host) &&
      (!state.f.status || (state.f.status==="Active" ? ACTIVE.has(r.status) : r.status===state.f.status)) &&
      (!state.f.day || r.date===state.f.day));
  }
  const byWhen = (a,b) => (a.date||"9").localeCompare(b.date||"9") || (a.time||"99").localeCompare(b.time||"99");

  function renderSummary(){
    if(!state.loaded){ $("#summary").innerHTML = ""; return; }
    const act = state.res.filter(r=>ACTIVE.has(r.status));
    const holds = act.filter(r=>r.status==="Hold").length;
    const conf = act.filter(r=>r.status==="Confirmed").length;
    const covers = act.reduce((s,r)=>s+(Number(r.party)||0),0);
    const attn = state.res.filter(r=>flagsFor(r).length).length;
    const pl = (n,w) => n+" "+w+(n===1?"":"s");
    $("#summary").innerHTML = `<span><b>${holds}</b> ${holds===1?"hold":"holds"}</span><span><b>${conf}</b> confirmed</span><span><b>${covers}</b> ${covers===1?"cover":"covers"}</span>${attn?`<span class="attn">${pl(attn,"booking")} need${attn===1?"s":""} attention</span>`:""}`;
  }

  function statusControl(r){
    if(!state.isOwner) return "";
    const opts = ["Hold","Confirmed","Released","Cancelled"].map(s=>`<option${s===r.status?" selected":""}>${s}</option>`).join("");
    const del = state.confirmDel===r.id
      ? `<button class="btn sm danger" data-act="del-yes" data-id="${esc(r.id)}">Delete for good</button><button class="btn sm" data-act="del-no">Keep</button>`
      : `<button class="btn sm danger" data-act="del" data-id="${esc(r.id)}">Delete</button>`;
    return `<div class="cardfoot"><label class="msg" for="st_${esc(r.id)}">Status</label><select id="st_${esc(r.id)}" data-act="status" data-id="${esc(r.id)}">${opts}</select><button class="btn sm" data-act="edit" data-id="${esc(r.id)}">Edit</button>${del}</div>`;
  }

  function card(r){
    const fl = flagsFor(r);
    const map = safeUrl(r.map);
    const rows = [
      ["Host", esc(r.host||"—")],
      ["Party", esc(r.party||"—") + (r.company?` · ${esc(r.company)}`:"") + (r.purpose?` · ${esc(r.purpose)}`:"")],
      r.attendees ? ["Who", esc(r.attendees)] : null,
      ["Conf #", r.conf?`<span class="mono">${esc(r.conf)}</span>`:`<span class="msg">none yet</span>`],
      r.bookedUnder||r.platform ? ["Booked", esc([r.bookedUnder,r.platform].filter(Boolean).join(" · "))] : null,
      r.cancelBy ? ["Cancel by", esc(fmtDeadline(r.cancelBy)) + (r.fee?` · fee ${esc(r.fee)}`:"")] : (r.fee?["Fee",esc(r.fee)]:null),
      r.deposit ? ["Guarantee", esc(r.deposit)] : null,
      r.travel ? ["Leave booth", `<b>${esc(leaveBy(r)||"—")}</b> <span class="msg">(${esc(r.travel)} min booth-to-table)</span>`] : null,
      r.notes ? ["Notes", esc(r.notes)] : null
    ].filter(Boolean);
    return `<article class="card is-${esc((r.status||"").toLowerCase())}">
      <div class="row1"><div><span class="time">${fmtTime(r.time)}</span><span class="meal">${esc(r.meal||"")}</span></div><span class="pill st-${esc(r.status)}">${esc(r.status||"—")}</span></div>
      <div><div class="rname">${esc(r.restaurant||"Untitled")}</div><div class="loc">${(()=>{const a=state.areas.find(x=>x.id===r.area);return a?`<span class="areachip">${esc(a.short||a.name)}</span> `:""})()}${esc(r.location||"")}${map?` · <a href="${esc(map)}" target="_blank" rel="noopener">Map</a>`:""}</div></div>
      ${fl.length?`<div class="flags">${fl.map(f=>`<div class="flag ${f.lvl}">${esc(f.text)}</div>`).join("")}</div>`:""}
      <dl class="kv">${rows.map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${statusControl(r)}
    </article>`;
  }

  function filterBar(){
    const hosts = [...new Set(state.res.map(r=>r.host).filter(Boolean))].sort();
    const days = [...new Set([...DAYS, ...state.res.map(r=>r.date).filter(Boolean)])].sort();
    return `<div class="filters">
      <select id="fl_host" aria-label="Filter by host"><option value="">All hosts</option>${hosts.map(h=>`<option${h===state.f.host?" selected":""}>${esc(h)}</option>`).join("")}</select>
      <select id="fl_status" aria-label="Filter by status">${[["","All statuses"],["Active","Holds + confirmed"],["Hold","Hold"],["Confirmed","Confirmed"],["Released","Released"],["Cancelled","Cancelled"]].map(([v,l])=>`<option value="${v}"${v===state.f.status?" selected":""}>${l}</option>`).join("")}</select>
      <select id="fl_day" aria-label="Filter by day"><option value="">All days</option>${days.map(d=>`<option value="${d}"${d===state.f.day?" selected":""}>${esc(dayLabel(d))}</option>`).join("")}</select>
    </div>`;
  }

  function emptyState(){
    if(!state.loaded) return `<div class="empty"><strong>Loading reservations…</strong>Connecting to the shared tracker.</div>`;
    if(state.res.length===0) return `<div class="empty"><strong>No reservations yet</strong>${state.isOwner?"Use “+ Add reservation” to log your first hold, or pick a spot from the Where to eat tab.":"Linda hasn’t added any holds yet. Check back closer to the show."}</div>`;
    return `<div class="empty"><strong>Nothing matches these filters</strong>Clear a filter to see more.</div>`;
  }

  function viewSchedule(){
    const list = filtered().sort(byWhen);
    let html = filterBar();
    if(!list.length) return html + emptyState();
    const days = [...new Set(list.map(r=>r.date||""))];
    for(const d of days){
      const items = list.filter(r=>(r.date||"")===d);
      const covers = items.filter(r=>ACTIVE.has(r.status)).reduce((s,r)=>s+(Number(r.party)||0),0);
      html += `<section class="day"><div class="dayhead"><h2>${esc(dayLabel(d))}</h2><span>${items.length} booking${items.length===1?"":"s"} · ${covers} covers</span></div><div class="cards">${items.map(card).join("")}</div></section>`;
    }
    return html;
  }

  function viewHost(){
    const list = filtered().filter(r=>ACTIVE.has(r.status)).sort(byWhen);
    let html = filterBar();
    if(!list.length) return html + emptyState();
    const hosts = [...new Set(list.map(r=>r.host||"Unassigned"))].sort();
    html += `<div class="hostgrid">` + hosts.map(h=>{
      const items = list.filter(r=>(r.host||"Unassigned")===h);
      return `<article class="card hostcard"><h3>${esc(h)}</h3><div class="msg">${items.length} active booking${items.length===1?"":"s"}</div><ol>${items.map(r=>{
        const fl = flagsFor(r).length?` <span class="pill st-Cancelled">check</span>`:"";
        const lb = leaveBy(r);
        return `<li><b>${esc(shortDay(r.date))} ${fmtTime(r.time)}</b> · ${esc(r.restaurant||"")} <span>(${esc(r.party||"?")} · ${esc(r.status)}${r.conf?` · #${esc(r.conf)}`:""}${lb?` · leave booth ${esc(lb)}`:""})</span>${fl}</li>`;}).join("")}</ol></article>`;
    }).join("") + `</div>`;
    return html;
  }

  const COLS = [["date","Day"],["time","Time"],["travel","Leave booth"],["meal","Meal"],["restaurant","Restaurant"],["host","Host"],["party","Party"],["status","Status"],["conf","Conf #"],["cancelBy","Cancel by"],["company","Guest co."],["platform","Via"]];
  function viewAll(){
    const k = state.sort.key, dir = state.sort.dir;
    const list = filtered().sort((a,b)=>{
      const av = a[k] ?? "", bv = b[k] ?? "";
      const c = (k==="party"||k==="travel") ? (Number(av)||0)-(Number(bv)||0) : String(av).localeCompare(String(bv));
      return (c || byWhen(a,b)) * dir;
    });
    let html = filterBar();
    if(!list.length) return html + emptyState();
    html += `<div class="tablewrap"><table><thead><tr>${COLS.map(([key,l])=>`<th data-sort="${key}" scope="col">${l}${state.sort.key===key?(dir>0?" ▲":" ▼"):""}</th>`).join("")}${state.isOwner?"<th scope=\"col\"></th>":""}</tr></thead><tbody>`;
    html += list.map(r=>{
      const fl = flagsFor(r);
      return `<tr class="${fl.length?"flagged":""}" title="${esc(fl.map(f=>f.text).join(" • "))}">
        <td>${esc(shortDay(r.date))}</td><td class="num">${fmtTime(r.time)}</td><td class="num">${esc(leaveBy(r)||"—")}</td><td>${esc(r.meal||"")}</td>
        <td><b>${esc(r.restaurant||"")}</b><div class="msg">${esc(r.location||"")}</div></td>
        <td>${esc(r.host||"")}</td><td class="num">${esc(r.party||"")}</td>
        <td><span class="pill st-${esc(r.status)}">${esc(r.status||"")}</span></td>
        <td class="mono">${esc(r.conf||"")}</td><td>${esc(fmtDeadline(r.cancelBy))}</td>
        <td>${esc(r.company||"")}</td><td>${esc(r.platform||"")}</td>
        ${state.isOwner?`<td><button class="btn sm" data-act="edit" data-id="${esc(r.id)}">Edit</button></td>`:""}</tr>`;
    }).join("");
    return html + `</tbody></table></div>`;
  }

  function nearCard(n){
    const map = safeUrl(n.mapUrl), book = safeUrl(n.bookUrl);
    const ar = state.areas.find(x=>x.id===n.area);
    const parts = [`${esc(n.exitMin)} min to leave the hall`];
    if(Number(n.walkMin)) parts.push(`${esc(n.walkMin)} min ${esc((n.walkLabel||"walk").toLowerCase())}`);
    if(Number(n.insideMin)) parts.push(`${esc(n.insideMin)} min ${Number(n.walkMin)?"inside":"in line"}`);
    const extra = [
      n.bookingNote ? `<div><span class="k">Booking</span>${esc(n.bookingNote)}</div>` : "",
      n.phone ? `<div><span class="k">Phone</span><span class="mono">${esc(n.phone)}</span></div>` : "",
      n.route ? `<div><span class="k">Route</span>${esc(n.route)}</div>` : "",
      `<div><span class="k">Time</span>${parts.join(" + ")}</div>`,
      map ? `<div><a href="${esc(map)}" target="_blank" rel="noopener">Open in Maps</a></div>` : ""
    ].join("");
    const actions = [];
    if(book) actions.push(`<a class="btn sm" href="${esc(book)}" target="_blank" rel="noopener">Book online</a>`);
    if(state.isOwner && n.booking!=="Walk-in" && n.booking!=="Grab-and-go") actions.push(`<button class="btn sm" data-act="usenear" data-id="${esc(n.id)}" title="Opens the reservation form filled in with this restaurant, so you can record a booking you've made">Add to tracker</button>`);
    return `<article class="card ncard">
        <div class="row1"><div class="rname">${esc(n.name)}</div><span class="pill bk-${esc(n.booking)}">${esc(n.booking==="Walk-in"?"Walk-in only":n.booking)}</span></div>
        <div class="loc">${esc(n.venue||"")}${n.meals?` · ${esc(n.meals)}`:""}</div>
        ${n.total?`<div class="eta"><b>${esc(n.total)} min</b> from your booth <span class="msg">· up to ${esc(n.totalBusy)} when busy</span></div>`:""}
        ${n.hours?`<div class="msg">${esc(n.hours)}</div>`:""}
        ${n.watch?`<div class="watch">${esc(n.watch)}</div>`:""}
        <details class="more"><summary>Details</summary><div class="moreb">${extra}</div></details>
        ${actions.length?`<div class="cardfoot">${actions.join("")}</div>`:""}
      </article>`;
  }

  /* Meal views: breakfast, dinner and drinks are grouped by area (where guests stay);
     lunch is a short closest-first list because the booth lunch is catered. */
  const MEALS = [
    ["Breakfast","Breakfast","Grouped by area, closest to Central Hall first. Best when the guest is staying at that hotel."],
    ["Dinner","Dinner","Grouped by area, closest to Central Hall first. Tap an area to see its restaurants."],
    ["Drinks","Drinks","Bars for casual customer drinks after the show floor closes."],
    ["Lunch","Lunch","Booth lunch is catered, so important lunch meetings happen at the booth. These are for overflow or a quick team bite, closest first."]
  ];
  function viewNearby(){
    const mode = MEALS.some(m=>m[0]===state.nearMode) ? state.nearMode : "Breakfast";
    const seg = MEALS.map(([k,l])=>`<button class="segb" data-near="${k}" aria-pressed="${mode===k}">${l}</button>`).join("");
    const opts = [["","Any booking type"],["Reservable","Reservable"],["Walk-in","Walk-in only"],["Unconfirmed","Unconfirmed"],["Grab-and-go","Grab-and-go"]];
    /* "Close enough": cap on the typical booth-to-table time (the card's headline number) */
    const maxOpts = [["","Any distance"],["15","Within 15 min"],["20","Within 20 min"],["25","Within 25 min"]];
    let html = `<div class="nearbar"><div class="seg" role="group" aria-label="Meal">${seg}</div><select id="fl_near" aria-label="Filter by booking type">${opts.map(([v,l])=>`<option value="${v}"${v===state.nearF?" selected":""}>${l}</option>`).join("")}</select><select id="fl_nearmax" aria-label="Filter by time from your booth">${maxOpts.map(([v,l])=>`<option value="${v}"${v===state.nearMax?" selected":""}>${l}</option>`).join("")}</select></div>`;
    if(!state.nearLoaded) return html + `<div class="empty"><strong>Loading restaurants…</strong></div>`;
    const bk = {"Reservable":0,"Unconfirmed":1,"Walk-in":2,"Grab-and-go":3};
    const maxMin = Number(state.nearMax) || Infinity;
    const items = state.nearby.filter(n=>(!state.nearF || n.booking===state.nearF) && Array.isArray(n.fit) && n.fit.includes(mode) && (Number(n.total)||Infinity) <= maxMin);
    html += `<p class="lead">${esc(MEALS.find(m=>m[0]===mode)[2])}</p>`;
    if(!items.length) return html + `<div class="empty">No ${esc(mode.toLowerCase())} spots match this filter.</div>`;
    if(mode==="Lunch"){
      const list = items.sort((a,b)=>(Number(a.total)||99)-(Number(b.total)||99) || (bk[a.booking]??4)-(bk[b.booking]??4));
      return html + `<div class="near">${list.map(nearCard).join("")}</div>`;
    }
    const areas = [...state.areas].sort((x,y)=>(x.order||0)-(y.order||0)).filter(ar=>items.some(n=>n.area===ar.id));
    html += areas.map(ar=>{
      const list = items.filter(n=>n.area===ar.id).sort((x,y)=>(bk[x.booking]??4)-(bk[y.booking]??4) || (Number(x.total)||99)-(Number(y.total)||99));
      const open = state.openAreas.has(ar.id);
      return `<details class="area" data-area="${esc(ar.id)}"${open?" open":""}>
        <summary><span class="an">${esc(ar.name)}</span><span class="ac">${list.length} place${list.length===1?"":"s"}${ar.f1Risk?` · <span class="f1tag">F1 zone</span>`:""}</span></summary>
        <div class="ab">
          <p>${esc(ar.blurb||"")}</p>
          ${ar.getThere?`<p><span class="k">Getting there</span>${esc(ar.getThere)}</p>`:""}
          ${ar.whoStays?`<p><span class="k">Who stays here</span>${esc(ar.whoStays)}</p>`:""}
          ${ar.f1?`<p class="f1note"><span class="k">F1 week</span>${esc(ar.f1)}</p>`:""}
          <div class="near">${list.map(nearCard).join("")}</div>
        </div></details>`;
    }).join("");
    html += `<p class="note">Times, hours and booking policies are estimates from public listings (October 2026). Confirm before relying on them.</p>`;
    return html;
  }

  function render(){
    renderSummary();
    document.querySelectorAll(".tab").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.tab===state.tab)));
    const v = state.tab==="schedule"?viewSchedule():state.tab==="host"?viewHost():state.tab==="all"?viewAll():viewNearby();
    $("#view").innerHTML = (state.err?`<div class="flag bad" style="margin-bottom:12px">${esc(state.err)}</div>`:"") + v;
    const fa = $("#f_area"); if(fa && fa.options.length !== state.areas.length+1){ const cur = fa.value; fa.innerHTML = `<option value="">—</option>` + [...state.areas].sort((a,b)=>(a.order||0)-(b.order||0)).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join(""); fa.value = cur; }
    $("#hostList").innerHTML = [...new Set(state.res.map(r=>r.host).filter(Boolean))].map(h=>`<option value="${esc(h)}">`).join("");
  }

  /* ---------- Form ---------- */
  const FIELDS = {area:"f_area",date:"f_date",time:"f_time",meal:"f_meal",status:"f_status",restaurant:"f_restaurant",location:"f_location",map:"f_map",travel:"f_travel",host:"f_host",party:"f_party",company:"f_company",purpose:"f_purpose",attendees:"f_attendees",conf:"f_conf",bookedUnder:"f_bookedUnder",platform:"f_platform",cancelBy:"f_cancelBy",fee:"f_fee",deposit:"f_deposit",notes:"f_notes"};
  function openForm(r, prefill){
    state.editing = r ? r.id : null;
    $("#formTitle").textContent = r ? "Edit reservation" : "Add reservation";
    const src = r || prefill || {};
    for(const [k,id] of Object.entries(FIELDS)){
      const el = document.getElementById(id);
      el.value = src[k] ?? (k==="status"?"Hold":k==="meal"?"Dinner":"");
    }
    $("#formMsg").textContent = ""; $("#formMsg").className="msg";
    $("#formPanel").hidden = false;
    $("#formPanel").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth", block:"start"});
    $("#f_date").focus();
  }
  function closeForm(){ $("#formPanel").hidden = true; state.editing = null; }

  $("#resForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!state.db || !state.isOwner) return;
    const data = {};
    for(const [k,id] of Object.entries(FIELDS)){
      let v = document.getElementById(id).value.trim();
      if((k==="party"||k==="travel") && v!=="") v = Number(v);
      data[k] = v;
    }
    data.updatedAt = new Date().toISOString();
    $("#saveBtn").disabled = true; $("#formMsg").textContent = "Saving…"; $("#formMsg").className="msg";
    try{
      if(state.editing) await state.db.collection("reservations").doc(state.editing).set(data);
      else await state.db.collection("reservations").add(data);
      closeForm();
    }catch(err){
      $("#formMsg").textContent = "Couldn’t save: " + (err && err.code==="quota_exceeded" ? "the tracker is full; delete old rows first." : "check your connection and try again.");
      $("#formMsg").className = "msg err";
    }finally{ $("#saveBtn").disabled = false; }
  });
  $("#cancelBtn").addEventListener("click", closeForm);
  $("#addBtn").addEventListener("click", ()=>openForm(null));

  /* ---------- Events ---------- */
  $("#tabs").addEventListener("click", e=>{ const b=e.target.closest(".tab"); if(!b) return; state.tab=b.dataset.tab; state.confirmDel=null; render(); });
  $("#view").addEventListener("change", async e=>{
    const t = e.target;
    if(t.id==="fl_host"){ state.f.host=t.value; render(); }
    else if(t.id==="fl_status"){ state.f.status=t.value; render(); }
    else if(t.id==="fl_day"){ state.f.day=t.value; render(); }
    else if(t.id==="fl_near"){ state.nearF=t.value; render(); }
    else if(t.id==="fl_nearmax"){ state.nearMax=t.value; render(); }
    else if(t.dataset.act==="status" && state.db && state.isOwner){
      try{ await state.db.collection("reservations").doc(t.dataset.id).update({status:t.value, updatedAt:new Date().toISOString()}); }
      catch(err){ state.err="Status change didn’t save. Try again."; render(); }
    }
  });
  $("#view").addEventListener("toggle", e=>{
    const d = e.target; if(!d.matches || !d.matches("details.area")) return;
    if(d.open) state.openAreas.add(d.dataset.area); else state.openAreas.delete(d.dataset.area);
  }, true);
  $("#view").addEventListener("click", async e=>{
    const sb = e.target.closest("[data-near]");
    if(sb){ state.nearMode = sb.dataset.near; render(); return; }
    const th = e.target.closest("th[data-sort]");
    if(th){ const k=th.dataset.sort; state.sort = {key:k, dir: state.sort.key===k ? -state.sort.dir : 1}; render(); return; }
    const b = e.target.closest("[data-act]"); if(!b || b.tagName==="SELECT") return;
    const id = b.dataset.id, act = b.dataset.act;
    if(act==="edit"){ const r = state.res.find(x=>x.id===id); if(r) openForm(r); }
    else if(act==="del"){ state.confirmDel=id; render(); }
    else if(act==="del-no"){ state.confirmDel=null; render(); }
    else if(act==="del-yes" && state.db){
      state.confirmDel=null;
      try{ await state.db.collection("reservations").doc(id).delete(); }catch(err){ state.err="Delete didn’t go through. Try again."; render(); }
    }
    else if(act==="usenear"){
      const n = state.nearby.find(x=>x.id===id); if(!n) return;
      openForm(null, {area:n.area||"", restaurant:n.name, location:n.venue, map:n.mapUrl, travel:n.totalBusy||n.total||"", status:"Hold", meal:"Dinner",
        platform:/opentable/i.test(n.bookingNote||"")?"OpenTable":"", bookedUnder:"", notes:""});
    }
  });

  /* CSV export for an Excel copy */
  $("#exportBtn").addEventListener("click", async ()=>{
    if(!state.downloads) return;
    const keys = ["date","time","meal","restaurant","location","host","party","attendees","company","purpose","status","conf","bookedUnder","platform","cancelBy","fee","deposit","travel","map","notes"];
    const q = v => { const s=String(v??""); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
    const rows = [keys.join(",")].concat([...state.res].sort(byWhen).map(r=>keys.map(k=>q(r[k])).join(",")));
    try{ await state.downloads.save({filename:"RE+2026-dining-holds.csv", data:rows.join("\r\n")}); }catch(_){}
  });

  render();

  /* ---------- Azure backend adapter ----------
     Identity comes from Azure Static Web Apps built-in auth (/.auth/me).
     Data goes through the /api/data/{collection}/{id} Azure Functions API.
     Only users with the "editor" role can write; the API enforces this too. */
  const API = "/api/data";
  async function apiCall(method, path, body){
    const res = await fetch(API + path, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body ? {"Content-Type":"application/json"} : {},
      body: body ? JSON.stringify(body) : undefined
    });
    if(!res.ok){ const err = new Error("HTTP "+res.status); err.status = res.status; throw err; }
    return res.status === 204 ? null : res.json();
  }
  async function loadAll(){
    try{
      const [res, near, areas] = await Promise.all([apiCall("GET","/reservations"), apiCall("GET","/nearby"), apiCall("GET","/areas")]);
      state.res = res; state.nearby = near; state.areas = areas;
      state.loaded = true; state.nearLoaded = true;
      if(state.err && state.err.startsWith("Couldn")) state.err = "";
    }catch(e){
      state.loaded = true; state.nearLoaded = true;
      state.err = e.status===401 ? "Your sign-in expired. Reload the page to sign in again." : "Couldn’t load the latest data. It will retry automatically.";
    }
    if($("#formPanel").hidden) render();
  }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,"") : String(Date.now())+Math.random().toString(16).slice(2));
  /* Small shim with the same shape the page already uses */
  const db = {
    collection(name){
      return {
        doc(id){
          id = id || newId();
          return {
            async set(data){ await apiCall("PUT", `/${name}/${encodeURIComponent(id)}`, data); await loadAll(); },
            async update(data){ await apiCall("PATCH", `/${name}/${encodeURIComponent(id)}`, data); await loadAll(); },
            async delete(){ await apiCall("DELETE", `/${name}/${encodeURIComponent(id)}`); await loadAll(); }
          };
        },
        async add(data){ await this.doc().set(data); }
      };
    }
  };
  (async ()=>{
    let me = null;
    try{ const r = await fetch("/.auth/me", {cache:"no-store"}); me = (await r.json()).clientPrincipal; }catch(_){}
    state.isOwner = !!(me && Array.isArray(me.userRoles) && me.userRoles.includes("editor"));
    state.db = db;
    state.downloads = { async save({filename, data}){
      const url = URL.createObjectURL(new Blob([data], {type:"text/csv;charset=utf-8"}));
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
    }};
    $("#role").innerHTML = (state.isOwner ? "You can <b>edit</b> · others view only" : "View only") + ` · <a href="/.auth/logout" class="signout">Sign out</a>`;
    $("#addBtn").hidden = !state.isOwner;
    $("#exportBtn").hidden = false;
    await loadAll();
    setInterval(loadAll, 30000);           /* pick up changes made on other devices */
    setInterval(()=>{ if(state.loaded && $("#formPanel").hidden) render(); }, 10*60*1000);
  })();
})();
