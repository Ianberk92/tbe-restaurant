/* RE+ 2026 Dining Holds — front end. Plain JS, no build step. */
(function(){
  "use strict";
  const DAYS = ["2026-11-16","2026-11-17","2026-11-18","2026-11-19"];
  const ACTIVE = new Set(["Hold","Confirmed"]);
  const state = { res: [], nearby: [], areas: [], loaded:false, nearLoaded:false, isOwner:false, db:null, downloads:null,
    tab:"nearby", nearMode:"Breakfast", walkable:false, mapsKey:"", mine:false, showOff:false, todayOnly:false, me:null, editing:null, editingEtag:null, editingNear:null, nearDelArmed:false, confirmDel:null, err:"" };

  const $ = s => document.querySelector(s);
  const remember = (k, v) => { try{ localStorage.setItem("redine."+k, JSON.stringify(v)); }catch(_){} };
  const recall = (k, d) => { try{ const v = localStorage.getItem("redine."+k); return v==null ? d : JSON.parse(v); }catch(_){ return d; } };
  state.tab = recall("tab", "nearby") === "bookings" ? "bookings" : "nearby";
  state.mine = !!recall("mine", false);
  state.walkable = !!recall("walkable", false);
  /* Today's date in Las Vegas, so "today" is right wherever the viewer's laptop clock is set */
  const TODAY = (()=>{
    const q = new URLSearchParams(location.search).get("today");
    if(q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
    try{ return new Date().toLocaleDateString("en-CA",{timeZone:"America/Los_Angeles"}); }catch(_){ return new Date().toISOString().slice(0,10); }
  })();
  const SHOW_WEEK = DAYS.includes(TODAY);
  if(SHOW_WEEK){ state.tab = "bookings"; state.todayOnly = true; }
  /* Brand logo files live in app/brand/; hide the image cleanly if one hasn't been added yet */
  document.querySelectorAll("img[data-brand]").forEach(img=>{
    const hide = ()=>{ img.hidden = true; };
    if(img.complete && !img.naturalWidth) hide(); else img.addEventListener("error", hide);
  });
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const safeUrl = u => /^https?:\/\//i.test(u||"") ? u : "";
  /* Message for a failed save; 412 means another editor changed the row first */
  const saveError = (err, what) => err && err.status===412
    ? "Someone else changed this "+what+" since you opened it. Close the form to see their version, then edit again."
    : "Couldn’t save: check your connection and try again.";

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

  /* "Just mine": match the Host field against the signed-in person's name or email */
  function isMine(r){
    const me = state.me; if(!me) return false;
    const host = (r.host||"").trim().toLowerCase(); if(!host) return false;
    return me.tokens.includes(host) || (me.first && host.split(/\s+/)[0] === me.first);
  }
  const byWhen = (a,b) => (a.date||"9").localeCompare(b.date||"9") || (a.time||"99").localeCompare(b.time||"99");

  /* One line, only when bookings need a decision (deadlines, host conflicts, F1 race day, no confirmation #) */
  function renderSummary(){
    const attn = state.loaded ? state.res.filter(r=>flagsFor(r).length).length : 0;
    $("#summary").innerHTML = attn
      ? `<button type="button" class="attn" data-goto="bookings">${attn} booking${attn===1?"":"s"} need${attn===1?"s":""} attention →</button>`
      : "";
  }

  function statusControl(r){
    if(!state.isOwner) return "";
    const opts = ["Hold","Confirmed","Cancelled"].concat(r.status==="Released"?["Released"]:[]).map(s=>`<option${s===r.status?" selected":""}>${s}</option>`).join("");
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
    const lb = r.date===TODAY && ACTIVE.has(r.status) ? leaveBy(r) : "";
    return `<article class="card is-${esc((r.status||"").toLowerCase())}">
      ${lb?`<div class="leave">Leave the booth by <b>${esc(lb)}</b></div>`:""}
      <div class="row1"><div><span class="time">${fmtTime(r.time)}</span><span class="meal">${esc(r.meal||"")}</span></div><span class="pill st-${esc(r.status)}">${esc(r.status||"—")}</span></div>
      <div><div class="rname">${esc(r.restaurant||"Untitled")}</div><div class="loc">${(()=>{const a=state.areas.find(x=>x.id===r.area);return a?`<span class="areachip">${esc(a.short||a.name)}</span> `:""})()}${esc(r.location||"")}${map?` · <a href="${esc(map)}" target="_blank" rel="noopener">Map</a>`:""}</div></div>
      ${fl.length?`<div class="flags">${fl.map(f=>`<div class="flag ${f.lvl}">${esc(f.text)}</div>`).join("")}</div>`:""}
      <dl class="kv">${rows.map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${statusControl(r)}
    </article>`;
  }

  function emptyState(kind){
    if(!state.loaded) return `<div class="empty"><strong>Loading bookings…</strong>Connecting to the shared tracker.</div>`;
    if(kind==="none") return `<div class="empty"><strong>No bookings yet</strong>${state.isOwner?"Use “+ Add booking”, or pick a spot from Places and choose “+ Booking”.":"No holds have been added yet. Check back closer to the show."}</div>`;
    if(kind==="today") return `<div class="empty"><strong>Nothing booked for today</strong>Turn off “Today only” to see the rest of the week.</div>`;
    if(kind==="mine") return `<div class="empty"><strong>Nothing hosted by you yet</strong>Turn off “Just mine” to see everyone’s bookings.</div>`;
    return `<div class="empty"><strong>No active bookings</strong>Turn on “Show cancelled” to see released and cancelled ones.</div>`;
  }

  function viewBookings(){
    const all = [...state.res].sort(byWhen);
    const offCount = all.filter(r=>!ACTIVE.has(r.status)).length;
    const list = all.filter(r=>(state.showOff || ACTIVE.has(r.status)) && (!state.mine || isMine(r)) && (!state.todayOnly || r.date===TODAY));
    let html = `<div class="bkbar">`
      + (SHOW_WEEK ? `<label class="toggle"><input type="checkbox" id="fl_today"${state.todayOnly?" checked":""}> Today only</label>` : "")
      + (state.me ? `<label class="toggle"><input type="checkbox" id="fl_mine"${state.mine?" checked":""}> Just mine</label>` : "")
      + (offCount ? `<label class="toggle"><input type="checkbox" id="fl_off"${state.showOff?" checked":""}> Show cancelled (${offCount})</label>` : "")
      + `</div>`;
    if(!list.length) return html + emptyState(!state.res.length ? "none" : state.todayOnly ? "today" : state.mine ? "mine" : "active");
    for(const d of [...new Set(list.map(r=>r.date||""))]){
      const items = list.filter(r=>(r.date||"")===d);
      const covers = items.filter(r=>ACTIVE.has(r.status)).reduce((s,r)=>s+(Number(r.party)||0),0);
      html += `<section class="day"><div class="dayhead"><h2>${esc(dayLabel(d))}</h2><span>${items.length} booking${items.length===1?"":"s"} · ${covers} covers</span></div><div class="cards">${items.map(card).join("")}</div></section>`;
    }
    return html;
  }

  const BADGE = {"Reservable":"Book ahead","Walk-in":"Walk-in only","Unconfirmed":"Call first","Grab-and-go":"Grab & go"};
  /* tel: link from a listed number like "702-678-7777 (resort)" */
  function telHref(phone){
    const d = String(phone||"").replace(/\D/g,"");
    const ten = d.length===11 && d[0]==="1" ? d.slice(1) : d.slice(0,10);
    return ten.length===10 ? "tel:+1"+ten : "";
  }

  function nearCard(n){
    const book = safeUrl(n.bookUrl), tel = telHref(n.phone);
    const ar = state.areas.find(x=>x.id===n.area);
    const legs = [];
    if(Number(n.exitMin)) legs.push(`${esc(n.exitMin)} min to leave the hall`);
    if(Number(n.walkMin)) legs.push(`${esc(n.walkMin)} min ${esc((n.walkLabel||"walk").toLowerCase())}`);
    if(Number(n.insideMin)) legs.push(`${esc(n.insideMin)} min ${Number(n.walkMin)?"inside":"in line"}`);
    const extra = [
      n.meals ? `<div><span class="k">Food</span>${esc(n.meals)}</div>` : "",
      n.hours ? `<div><span class="k">Hours</span>${esc(n.hours)}</div>` : "",
      n.bookingNote ? `<div><span class="k">Booking</span>${esc(n.bookingNote)}</div>` : "",
      n.phone ? `<div><span class="k">Phone</span><span class="mono">${esc(n.phone)}</span></div>` : "",
      n.route ? `<div><span class="k">Route</span>${esc(n.route)}</div>` : "",
      legs.length ? `<div><span class="k">Time</span>${legs.join(" + ")}${n.totalBusy?` · up to ${esc(n.totalBusy)} min when busy`:""}</div>` : "",
      ar && ar.getThere && ar.getThere!=="Already there" ? `<div><span class="k">Area tip</span>${esc(ar.getThere)}</div>` : "",
      ar && ar.f1 && ar.f1Risk ? `<div><span class="k">F1 week</span>${esc(ar.f1)}</div>` : ""
    ].join("");
    const acts = [];
    if(book) acts.push(`<a class="btn sm primary" href="${esc(book)}" target="_blank" rel="noopener">Book</a>`);
    if(tel) acts.push(`<a class="btn sm" href="${esc(tel)}">Call</a>`);
    acts.push(`<button type="button" class="btn sm" data-act="map" data-id="${esc(n.id)}">Map</button>`);
    const own = state.isOwner
      ? `<div class="cardfoot">${n.booking!=="Walk-in" && n.booking!=="Grab-and-go" ? `<button class="btn sm" data-act="usenear" data-id="${esc(n.id)}" title="Log a booking you've made here">+ Booking</button>` : ""}<button class="btn sm" data-act="editnear" data-id="${esc(n.id)}">Edit</button></div>`
      : "";
    return `<article class="card ncard">
        <div class="row1"><button type="button" class="rname link" data-act="map" data-id="${esc(n.id)}">${esc(n.name)}</button><span class="pill bk-${esc(n.booking)}">${esc(BADGE[n.booking]||n.booking||"")}</span></div>
        ${n.total?`<div class="big">${esc(n.total)}<small>min from booth</small></div>`:""}
        <div class="loc">${ar?`<span class="areachip">${esc(ar.short||ar.name)}${ar.f1Risk?" · F1 zone":""}</span>`:""}${esc(n.venue||"")}</div>
        ${n.watch?`<div class="watch">${esc(n.watch)}</div>`:""}
        <div class="acts">${acts.join("")}</div>
        ${extra?`<details class="more"><summary>Details</summary><div class="moreb">${extra}</div></details>`:""}
        ${own}
      </article>`;
  }

  /* Places: one row of filters and a single list, closest to Central Hall first */
  const WALKABLE_MIN = 20;
  const MEALS = [
    ["Breakfast","Best when the guest is staying at that hotel."],
    ["Lunch","Booth lunch is catered; these are for overflow or a quick team bite."],
    ["Dinner",""],
    ["Drinks","For casual customer drinks after the show floor closes."]
  ];
  function viewNearby(){
    const mode = MEALS.some(m=>m[0]===state.nearMode) ? state.nearMode : "Breakfast";
    const seg = MEALS.map(([k])=>`<button class="segb" data-near="${k}" aria-pressed="${mode===k}">${k}</button>`).join("");
    let html = `<div class="nearbar"><div class="seg" role="group" aria-label="Meal">${seg}</div>`
      + `<label class="toggle"><input type="checkbox" id="fl_walk"${state.walkable?" checked":""}> Walkable (${WALKABLE_MIN} min or less)</label>`
      + (state.isOwner?`<button class="btn sm" data-act="addnear">+ Add restaurant</button>`:"") + `</div>`;
    if(!state.nearLoaded) return html + `<div class="empty"><strong>Loading restaurants…</strong></div>`;
    const bk = {"Reservable":0,"Unconfirmed":1,"Walk-in":2,"Grab-and-go":3};
    const items = state.nearby
      .filter(n=>Array.isArray(n.fit) && n.fit.includes(mode) && (!state.walkable || (Number(n.total)||Infinity) <= WALKABLE_MIN))
      .sort((a,b)=>(Number(a.total)||99)-(Number(b.total)||99) || (bk[a.booking]??4)-(bk[b.booking]??4) || String(a.name).localeCompare(String(b.name)));
    const tip = MEALS.find(m=>m[0]===mode)[1];
    html += `<p class="lead">Closest to Central Hall first.${tip?" "+esc(tip):""}</p>`;
    if(!items.length) return html + `<div class="empty">No ${esc(mode.toLowerCase())} spots within ${WALKABLE_MIN} minutes. Turn off “Walkable” to see more.</div>`;
    html += `<div class="near">${items.map(nearCard).join("")}</div>`;
    html += `<p class="note">Times, hours and booking policies are estimates from public listings (October 2026). Confirm before relying on them.</p>`;
    return html;
  }

  /* ---------- Map popup ----------
     Shows the route from Central Hall (or the team hotel) to the restaurant in an embedded Google map,
     with the hotels around it. Uses Google's official Maps Embed API when the site has a key
     (app setting GOOGLE_MAPS_EMBED_KEY, served by /api/config); otherwise Google's keyless embed.
     The "Open in Google Maps" link uses Google's documented directions URL either way. */
  const ORIGINS = {
    lvcc: { label:"Central Hall", q:"Las Vegas Convention Center Central Hall, 3150 Paradise Rd, Las Vegas, NV 89109" },
    linq: { label:"The LINQ", q:"The LINQ Hotel, 3535 S Las Vegas Blvd, Las Vegas, NV 89109" }
  };
  const WALK_AREAS = new Set(["lvcc","paradise","westgate"]);
  let mapPlace = null, mapFrom = "lvcc";
  function drawMap(){
    const n = mapPlace; if(!n) return;
    const dest = [n.name, n.venue, "Las Vegas, NV"].filter(Boolean).join(", ");
    const walk = WALK_AREAS.has(n.area) || mapFrom==="linq" && n.area==="linq";
    const o = ORIGINS[mapFrom];
    $("#mapFrame").src = state.mapsKey
      ? "https://www.google.com/maps/embed/v1/directions?" + new URLSearchParams({key:state.mapsKey, origin:o.q, destination:dest, mode: walk?"walking":"transit"})
      : "https://maps.google.com/maps?" + new URLSearchParams({saddr:o.q, daddr:dest, ...(walk?{dirflg:"w"}:{}), output:"embed"});
    $("#mapOpen").href = "https://www.google.com/maps/dir/?" + new URLSearchParams({api:"1", origin:o.q, destination:dest, travelmode: walk?"walking":"transit"});
    document.querySelectorAll("#mapDlg [data-from]").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.from===mapFrom)));
    const ar = state.areas.find(x=>x.id===n.area);
    $("#mapNote").textContent = mapFrom==="lvcc" && n.route ? "How the team gets there: " + n.route
      : ar && ar.getThere && ar.getThere!=="Already there" ? ar.getThere : "";
  }
  function openMap(n){
    mapPlace = n; mapFrom = "lvcc";
    $("#mapTitle").textContent = n.name;
    $("#mapSub").textContent = [n.total ? n.total+" min from your booth" : "", n.venue].filter(Boolean).join(" · ");
    drawMap();
    const dlg = $("#mapDlg");
    if(typeof dlg.showModal === "function") dlg.showModal(); else window.open($("#mapOpen").href, "_blank", "noopener");
  }
  $("#mapDlg").addEventListener("click", e=>{
    const b = e.target.closest("[data-from]"); if(b){ mapFrom = b.dataset.from; drawMap(); return; }
    if(e.target === $("#mapDlg")) $("#mapDlg").close();   /* click on the backdrop */
  });
  $("#mapClose").addEventListener("click", ()=>$("#mapDlg").close());
  $("#mapDlg").addEventListener("close", ()=>{ $("#mapFrame").src = "about:blank"; mapPlace = null; });

  function render(){
    renderSummary();
    document.querySelectorAll(".tab").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.tab===state.tab)));
    const v = state.tab==="bookings" ? viewBookings() : viewNearby();
    $("#view").innerHTML = (state.err?`<div class="flag bad" style="margin-bottom:12px">${esc(state.err)}</div>`:"") + v;
    for(const fa of [$("#f_area"), $("#n_area")]){ if(fa && fa.options.length !== state.areas.length+1){ const cur = fa.value; fa.innerHTML = `<option value="">—</option>` + [...state.areas].sort((a,b)=>(a.order||0)-(b.order||0)).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join(""); fa.value = cur; } }
    $("#hostList").innerHTML = [...new Set(state.res.map(r=>r.host).filter(Boolean))].map(h=>`<option value="${esc(h)}">`).join("");
    $("#placeList").innerHTML = [...state.nearby].sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(n=>`<option value="${esc(n.name)}">`).join("");
  }

  /* ---------- Form ---------- */
  const FIELDS = {area:"f_area",date:"f_date",time:"f_time",meal:"f_meal",status:"f_status",restaurant:"f_restaurant",location:"f_location",map:"f_map",travel:"f_travel",host:"f_host",party:"f_party",company:"f_company",purpose:"f_purpose",attendees:"f_attendees",conf:"f_conf",bookedUnder:"f_bookedUnder",platform:"f_platform",cancelBy:"f_cancelBy",fee:"f_fee",deposit:"f_deposit",notes:"f_notes"};
  const ESSENTIAL = new Set(["restaurant","date","time","party","host"]);
  /* Day buttons for the four show days; "Other date" under More details covers anything else */
  $("#f_days").insertAdjacentHTML("beforeend", DAYS.map(d=>{
    const dt = new Date(d+"T12:00:00");
    return `<button type="button" class="dayb" data-day="${d}" aria-pressed="false">${dt.toLocaleDateString("en-US",{weekday:"short"})}<small>${dt.toLocaleDateString("en-US",{month:"short",day:"numeric"})}</small></button>`;
  }).join(""));
  function syncDays(){ const v = $("#f_date").value; document.querySelectorAll(".dayb").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.day===v))); }
  function syncMoreCount(){
    const n = Object.entries(FIELDS).filter(([k,id])=>!ESSENTIAL.has(k) && k!=="status" && document.getElementById(id).value.trim()).length;
    $("#f_moreCount").textContent = n ? `(${n} filled)` : "";
  }
  /* Picking a restaurant from Places fills in where it is and how long it takes to get there */
  function fillFromPlace(){
    const name = $("#f_restaurant").value.trim().toLowerCase();
    const n = state.nearby.find(x=>String(x.name||"").toLowerCase()===name);
    if(!n){ $("#f_placeHint").textContent = ""; return; }
    $("#f_area").value = n.area || "";
    $("#f_location").value = n.venue || "";
    $("#f_map").value = safeUrl(n.mapUrl);
    $("#f_travel").value = n.totalBusy || n.total || "";
    if(!$("#f_platform").value){ const m = /(OpenTable|SevenRooms|Resy|Tock)/i.exec(n.bookingNote||""); if(m) $("#f_platform").value = [...$("#f_platform").options].map(o=>o.value).find(v=>v.toLowerCase()===m[1].toLowerCase()) || ""; }
    $("#f_placeHint").textContent = "Filled in the area, map link and walk time from Places.";
    syncMoreCount();
  }
  /* Meal is optional: when left on Auto it follows the booking time */
  function mealFor(time){
    const t = mins(time); if(t==null) return "";
    return t < 10*60+30 ? "Breakfast" : t < 15*60 ? "Lunch" : t < 21*60+30 ? "Dinner" : "Drinks";
  }
  function openForm(r, prefill){
    if(!$("#nearPanel").hidden){ $("#nearPanel").hidden = true; state.editingNear = null; }
    state.editing = r ? r.id : null;
    state.editingEtag = r ? r.etag : null;
    $("#formTitle").textContent = r ? "Edit booking" : "Add booking";
    const src = r || prefill || {};
    const rel = [...$("#f_status").options].find(o=>o.value==="Released");
    if(src.status==="Released" && !rel) $("#f_status").add(new Option("Released","Released"));
    else if(src.status!=="Released" && rel) rel.remove();
    for(const [k,id] of Object.entries(FIELDS)){
      const el = document.getElementById(id);
      el.value = src[k] ?? (k==="status" ? "Hold" : k==="host" && !r && state.me ? state.me.display : "");
    }
    syncDays(); syncMoreCount();
    $("#f_placeHint").textContent = "";
    $("#f_more").open = !!(src.date && !DAYS.includes(src.date));   /* show "Other date" when it holds the date */
    $("#formMsg").textContent = ""; $("#formMsg").className="msg";
    $("#formPanel").hidden = false;
    $("#formPanel").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth", block:"start"});
    (src.restaurant ? (document.querySelector(".dayb[aria-pressed=true]") || document.querySelector(".dayb")) : $("#f_restaurant")).focus();
  }
  function closeForm(){ $("#formPanel").hidden = true; state.editing = null; state.editingEtag = null; render(); }
  $("#f_days").addEventListener("click", e=>{ const b = e.target.closest(".dayb"); if(!b) return; $("#f_date").value = b.dataset.day; syncDays(); });
  $("#f_date").addEventListener("change", syncDays);
  $("#f_restaurant").addEventListener("change", fillFromPlace);
  /* If a field under "More details" fails validation, open the section so the browser can show the problem */
  $("#resForm").addEventListener("invalid", e=>{ if($("#f_more").contains(e.target)) $("#f_more").open = true; }, true);
  $("#resForm").addEventListener("input", e=>{ if(!ESSENTIAL.has(Object.keys(FIELDS).find(k=>FIELDS[k]===e.target.id))) syncMoreCount(); });

  $("#resForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!state.db || !state.isOwner) return;
    const data = {};
    for(const [k,id] of Object.entries(FIELDS)){
      let v = document.getElementById(id).value.trim();
      if((k==="party"||k==="travel") && v!=="") v = Number(v);
      data[k] = v;
    }
    if(!data.date){ $("#formMsg").textContent = "Pick a day (or an Other date under More details)."; $("#formMsg").className = "msg err"; return; }
    if(!data.meal) data.meal = mealFor(data.time);
    data.updatedAt = new Date().toISOString();
    $("#saveBtn").disabled = true; $("#formMsg").textContent = "Saving…"; $("#formMsg").className="msg";
    try{
      if(state.editing) await state.db.collection("reservations").doc(state.editing).set(data, {etag: state.editingEtag});
      else await state.db.collection("reservations").add(data);
      closeForm();
    }catch(err){
      $("#formMsg").textContent = saveError(err, "reservation");
      $("#formMsg").className = "msg err";
    }finally{ $("#saveBtn").disabled = false; }
  });
  $("#cancelBtn").addEventListener("click", closeForm);
  $("#addBtn").addEventListener("click", ()=>openForm(null));

  /* ---------- Restaurant form (editors) ---------- */
  const NEAR_FIELDS = {name:"n_name",area:"n_area",booking:"n_booking",venue:"n_venue",total:"n_total",totalBusy:"n_totalBusy",meals:"n_meals",hours:"n_hours",phone:"n_phone",bookUrl:"n_bookUrl",mapUrl:"n_mapUrl",bookingNote:"n_bookingNote",route:"n_route",watch:"n_watch"};
  const fitBoxes = () => [...document.querySelectorAll("#n_fit input[type=checkbox]")];
  function openNearForm(n){
    closeForm();
    state.editingNear = n ? n.id : null;
    state.nearDelArmed = false;
    $("#nearTitle").textContent = n ? "Edit restaurant" : "Add restaurant";
    const src = n || {booking:"Unconfirmed", fit:[state.nearMode]};
    for(const [k,id] of Object.entries(NEAR_FIELDS)) document.getElementById(id).value = src[k] ?? "";
    const fit = Array.isArray(src.fit) ? src.fit : [];
    fitBoxes().forEach(b=>{ b.checked = fit.includes(b.value); });
    $("#nearDelBtn").hidden = !n; $("#nearDelBtn").textContent = "Remove from list";
    $("#nearMsg").textContent = ""; $("#nearMsg").className = "msg";
    $("#nearPanel").hidden = false;
    $("#nearPanel").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth", block:"start"});
    $("#n_name").focus();
  }
  function closeNearForm(){ $("#nearPanel").hidden = true; state.editingNear = null; state.nearDelArmed = false; render(); }
  function nearFail(text){ $("#nearMsg").textContent = text; $("#nearMsg").className = "msg err"; }

  $("#nearForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!state.db || !state.isOwner) return;
    const data = {};
    for(const [k,id] of Object.entries(NEAR_FIELDS)){
      let v = document.getElementById(id).value.trim();
      if((k==="total"||k==="totalBusy") && v!=="") v = Number(v);
      data[k] = v;
    }
    data.fit = fitBoxes().filter(b=>b.checked).map(b=>b.value);
    if(!data.fit.length) return nearFail("Pick at least one meal so it shows up in a view.");
    data.updatedAt = new Date().toISOString();
    const existing = state.editingNear && state.nearby.find(x=>x.id===state.editingNear);
    $("#nearSaveBtn").disabled = true; $("#nearMsg").textContent = "Saving…"; $("#nearMsg").className = "msg";
    try{
      if(existing){
        /* Keep fields the form doesn't show (walk legs, hotel, distance) */
        const { id:_i, etag, ...rest } = existing;
        await state.db.collection("nearby").doc(existing.id).set({...rest, ...data}, {etag});
      } else {
        await state.db.collection("nearby").add(data);
      }
      closeNearForm();
    }catch(err){ nearFail(saveError(err, "restaurant")); }
    finally{ $("#nearSaveBtn").disabled = false; }
  });
  $("#nearCancelBtn").addEventListener("click", closeNearForm);
  $("#nearDelBtn").addEventListener("click", async ()=>{
    const n = state.editingNear && state.nearby.find(x=>x.id===state.editingNear);
    if(!n || !state.db) return;
    if(!state.nearDelArmed){ state.nearDelArmed = true; $("#nearDelBtn").textContent = "Click again to remove for good"; return; }
    try{ await state.db.collection("nearby").doc(n.id).delete({etag: n.etag}); closeNearForm(); }
    catch(err){ nearFail(err && err.status===412 ? "Someone else changed this restaurant, so it wasn’t removed. Close the form and check it." : "Couldn’t remove it. Try again."); }
  });

  /* ---------- Events ---------- */
  $("#summary").addEventListener("click", e=>{ if(!e.target.closest("[data-goto]")) return; state.tab="bookings"; remember("tab", state.tab); state.showOff=false; state.mine=false; render(); $("#view").scrollIntoView({block:"start"}); });
  $("#tabs").addEventListener("click", e=>{ const b=e.target.closest(".tab"); if(!b) return; state.tab=b.dataset.tab; remember("tab", state.tab); state.confirmDel=null; render(); });
  $("#view").addEventListener("change", async e=>{
    const t = e.target;
    if(t.id==="fl_mine"){ state.mine=t.checked; remember("mine", state.mine); render(); }
    else if(t.id==="fl_off"){ state.showOff=t.checked; render(); }
    else if(t.id==="fl_walk"){ state.walkable=t.checked; remember("walkable", state.walkable); render(); }
    else if(t.id==="fl_today"){ state.todayOnly=t.checked; render(); }
    else if(t.dataset.act==="status" && state.db && state.isOwner){
      try{ await state.db.collection("reservations").doc(t.dataset.id).update({status:t.value, updatedAt:new Date().toISOString()}); }
      catch(err){ state.err="Status change didn’t save. Try again."; render(); }
    }
  });
  $("#view").addEventListener("click", async e=>{
    const sb = e.target.closest("[data-near]");
    if(sb){ state.nearMode = sb.dataset.near; render(); return; }
    const b = e.target.closest("[data-act]"); if(!b || b.tagName==="SELECT") return;
    const id = b.dataset.id, act = b.dataset.act;
    if(act==="edit"){ const r = state.res.find(x=>x.id===id); if(r) openForm(r); }
    else if(act==="del"){ state.confirmDel=id; render(); }
    else if(act==="del-no"){ state.confirmDel=null; render(); }
    else if(act==="del-yes" && state.db){
      state.confirmDel=null;
      const r = state.res.find(x=>x.id===id);
      try{ await state.db.collection("reservations").doc(id).delete({etag: r && r.etag}); }
      catch(err){ state.err = err && err.status===412 ? "Someone else changed that reservation, so it wasn’t deleted. Check it and try again." : "Delete didn’t go through. Try again."; render(); }
    }
    else if(act==="addnear"){ openNearForm(null); }
    else if(act==="map"){ const n = state.nearby.find(x=>x.id===id); if(n) openMap(n); }
    else if(act==="editnear"){ const n = state.nearby.find(x=>x.id===id); if(n) openNearForm(n); }
    else if(act==="usenear"){
      const n = state.nearby.find(x=>x.id===id); if(!n) return;
      openForm(null, {restaurant:n.name, status:"Hold", meal: state.nearMode || ""});
      fillFromPlace();
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
  async function apiCall(method, path, body, etag){
    const headers = body ? {"Content-Type":"application/json"} : {};
    if(etag) headers["If-Match"] = etag;   /* server answers 412 if someone else saved first */
    const res = await fetch(API + path, {
      method, credentials: "same-origin", cache: "no-store", headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if(!res.ok){ const err = new Error("HTTP "+res.status); err.status = res.status; throw err; }
    return res.status === 204 ? null : res.json();
  }
  async function apiCallRaw(url){
    const res = await fetch(url, {credentials:"same-origin", cache:"no-store"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
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
    if($("#formPanel").hidden && $("#nearPanel").hidden) render();
  }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,"") : String(Date.now())+Math.random().toString(16).slice(2));
  /* Small shim with the same shape the page already uses */
  const db = {
    collection(name){
      return {
        doc(id){
          id = id || newId();
          return {
            async set(data, opts){
              try{ await apiCall("PUT", `/${name}/${encodeURIComponent(id)}`, data, opts && opts.etag); }
              finally{ await loadAll(); }   /* after a 412, closing the form then shows the other editor's version */
            },
            async update(data){ await apiCall("PATCH", `/${name}/${encodeURIComponent(id)}`, data); await loadAll(); },
            async delete(opts){
              try{ await apiCall("DELETE", `/${name}/${encodeURIComponent(id)}`, null, opts && opts.etag); }
              finally{ await loadAll(); }   /* refresh either way so a 412 shows the other editor's change */
            }
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
    if(me){
      const claim = t => ((me.claims||[]).find(c=>c.typ===t) || {}).val;
      const email = String(me.userDetails||"").toLowerCase();
      const full = String(claim("name") || "").trim();
      const first = (full.split(/\s+/)[0] || "").toLowerCase();
      const tokens = [full.toLowerCase(), first, email, email.split("@")[0]].filter(Boolean);
      if(tokens.length) state.me = { tokens, first, display: full ? full.split(/\s+/)[0] : "" };
    }
    state.db = db;
    state.downloads = { async save({filename, data}){
      const url = URL.createObjectURL(new Blob([data], {type:"text/csv;charset=utf-8"}));
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
    }};
    $("#role").innerHTML = (state.isOwner ? "<b>Editor</b>" : "View only") + ` · <a href="/.auth/logout" class="signout">Sign out</a>`;
    $("#addBtn").hidden = !state.isOwner;
    $("#exportBtn").hidden = false;
    await loadAll();
    try{ const c = await apiCallRaw("/api/config"); state.mapsKey = (c && c.mapsEmbedKey) || ""; }catch(_){}   /* optional: keyless map if missing */
    setInterval(loadAll, 30000);           /* pick up changes made on other devices */
    setInterval(()=>{ if(state.loaded && $("#formPanel").hidden && $("#nearPanel").hidden) render(); }, 10*60*1000);
  })();
})();
