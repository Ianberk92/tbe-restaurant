/* RE+ 2026 Dining Holds — front end. Plain JS, no build step. */
(function(){
  "use strict";
  const DAYS = ["2026-11-16","2026-11-17","2026-11-18","2026-11-19"];
  const ACTIVE = new Set(["Hold","Confirmed"]);
  const state = { res: [], nearby: [], areas: [], loaded:false, nearLoaded:false, isOwner:false, db:null, downloads:null,
    tab:"nearby", nearMode:"Breakfast", zone:"lvcc", hotel:"", mapsKey:"", mine:false, showOff:false, todayOnly:false, me:null, editing:null, editingEtag:null, editingNear:null, nearDelArmed:false, confirmDel:null, err:"" };

  const $ = s => document.querySelector(s);
  const remember = (k, v) => { try{ localStorage.setItem("redine."+k, JSON.stringify(v)); }catch(_){} };
  const recall = (k, d) => { try{ const v = localStorage.getItem("redine."+k); return v==null ? d : JSON.parse(v); }catch(_){ return d; } };
  state.tab = recall("tab", "nearby") === "bookings" ? "bookings" : "nearby";
  state.mine = !!recall("mine", false);
  state.zone = recall("zone", "lvcc") === "hotel" ? "hotel" : "lvcc";
  state.hotel = String(recall("hotel", "") || "");
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
    const up = state.updates;   /* editors only: new places shipped with the app but not yet in the live list */
    const what = up && up.pending ? `${up.pending} new place${up.pending===1?"":"s"}` : "New areas";
    const upHtml = !up ? "" : up.busy ? `<span class="upd">Adding new places…</span>`
      : up.failed ? `<button type="button" class="upd" data-act="load-updates">Couldn’t add them. Tap to try again</button>`
      : up.msg ? `<span class="upd">${esc(up.msg)}</span>`
      : up.pending || up.areas ? `<button type="button" class="upd" data-act="load-updates" title="${esc(up.names.join(", "))}${up.pending>up.names.length?", …":""}">＋ ${what} ready: add them to the list</button>` : "";
    $("#summary").innerHTML = (attn
      ? `<button type="button" class="attn" data-goto="bookings">${attn} booking${attn===1?"":"s"} need${attn===1?"s":""} attention →</button>`
      : "") + upHtml;
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

  function nearCard(n, mode, walk){
    const morning = mode === "Breakfast";
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
    if(book){
      /* A link shared by several places is a hotel-wide booking page (e.g. Fontainebleau's): say so */
      const shared = state.nearby.filter(x=>safeUrl(x.bookUrl)===book).length > 1;
      const where = n.hotel || n.venue || "the hotel";
      acts.push(shared
        ? `<a class="btn sm primary" href="${esc(book)}" target="_blank" rel="noopener" title="${esc(where)} books all its restaurants on one page; choose ${esc(n.name)} there">Book via ${esc(where)}</a>`
        : `<a class="btn sm primary" href="${esc(book)}" target="_blank" rel="noopener">Book</a>`);
    }
    if(tel) acts.push(`<a class="btn sm" href="${esc(tel)}">Call</a>`);
    acts.push(`<button type="button" class="btn sm" data-act="map" data-id="${esc(n.id)}">Map</button>`);
    const own = state.isOwner
      ? `<div class="cardfoot">${n.booking!=="Walk-in" && n.booking!=="Grab-and-go" ? `<button class="btn sm" data-act="usenear" data-id="${esc(n.id)}" title="Log a booking you've made here">+ Booking</button>` : ""}<button class="btn sm" data-act="editnear" data-id="${esc(n.id)}">Edit</button></div>`
      : "";
    return `<article class="card ncard">
        <div class="row1"><button type="button" class="rname link" data-act="map" data-id="${esc(n.id)}">${esc(n.name)}</button><span class="pill bk-${esc(n.booking)}">${esc(BADGE[n.booking]||n.booking||"")}</span></div>
        ${walk
          ? (walk.mins!=null ? `<div class="big">≈${esc(walk.mins)}<small>min walk from ${esc(walk.from)}</small></div>` : `<div class="hours">Tap Map for the walk from ${esc(walk.from)}</div>`)
          : n.total?`<div class="big">${esc(n.total)}<small>${morning?"min to Central Hall":"min from booth"}</small></div>`:""}
        ${morning && n.hours?`<div class="hours"><span class="k">Hours</span>${esc(n.hours)}</div>`:""}
        <div class="loc">${esc(n.venue||"")}</div>
        ${n.watch?`<div class="watch">${esc(n.watch)}</div>`:""}
        <div class="acts">${acts.join("")}</div>
        ${extra?`<details class="more"><summary>Details</summary><div class="moreb">${extra}</div></details>`:""}
        ${own}
      </article>`;
  }

  /* Places: one row of filters and a single list, closest to Central Hall first */
  const MEALS = [
    ["Breakfast",""],
    ["Lunch","Booth lunch is catered; these are for overflow or a quick team bite."],
    ["Dinner",""],
    ["Drinks","For casual customer drinks after the show floor closes."]
  ];
  /* Two questions, two buttons:
     "Near LVCC"    — what's closest to the booth right now (one list, closest first)
     "Near a hotel" — meet a customer at or next to their hotel
     Monorail stations (north to south) say how many stops each hotel is from LVCC. */
  const MONORAIL = {sahara:"2 Monorail stops north", linq:"1 Monorail stop south", flamingo:"2 Monorail stops south", paris:"3 Monorail stops south", mgm:"4 Monorail stops south"};
  const NEAR_LVCC = new Set(["lvcc","paradise","westgate","northstrip"]);   /* walk or Vegas Loop from Central Hall */
  const NOT_HOTELS = /^(LVCC|Peppermill)\b/;   /* venues listed in the hotel field that aren't hotels */
  const ZONES = [["lvcc","Near LVCC","What’s closest to the booth"],["hotel","Near a hotel","Dine near your customer’s hotel"]];
  /* "MGM Grand (inside Luchini)" -> "MGM Grand"; "The LINQ and Promenade" -> "The LINQ" */
  const hotelName = n => String(n.hotel || "").replace(/\s*\(.*\)\s*$/, "").replace(/ and Promenade$/, "").trim();
  /* RE+ 2026 housing block (list from the RE+ housing page, Oct 2026), mapped to the places we list.
     at:   hotel names (as in the restaurant data) that count as "at" this hotel
     area: where its "Next door" places come from (all places in that area that aren't "at")
     near: instead of the area, exactly these hotels' places (for hotels with nothing of their own)
     note: one line shown under the picker */
  const HOUSING = [
    {name:"Caesars Palace", at:["Caesars Palace"], area:"flamingo"},
    {name:"Courtyard LVCC", at:["Courtyard LVCC"], area:"paradise"},
    {name:"Embassy Suites Convention Center", at:["Embassy Suites Convention Center"], area:"paradise"},
    {name:"Harrah's", at:[], area:"linq", near:["The LINQ","Flamingo"], note:"Next door to The LINQ Promenade."},
    {name:"Hilton Grand Vacations on the Strip", at:[], area:"", near:["SAHARA","Fontainebleau"], note:"Nearest places we list. Check the walk on the map."},
    {name:"Hilton Grand Vacations Paradise", at:[], area:"paradise", note:"Nearest places we list. Check the walk on the map."},
    {name:"Las Vegas Marriott", at:["Las Vegas Marriott"], area:"paradise"},
    {name:"MGM Grand", at:["MGM Grand"], area:"mgm"},
    {name:"Renaissance Las Vegas", at:["Renaissance Las Vegas"], area:"paradise"},
    {name:"Residence Inn LVCC", at:[], area:"paradise", note:"Next to Courtyard LVCC on Paradise Rd."},
    {name:"Resorts World (Conrad, Hilton, Crockfords)", at:["Resorts World"], area:"northstrip"},
    {name:"SAHARA", at:["SAHARA"], area:"sahara"},
    {name:"SpringHill Suites LVCC", at:[], area:"paradise", note:"On Paradise Rd by the convention center."},
    {name:"The LINQ", at:["The LINQ"], area:"linq", near:["Flamingo"], note:"Terabase team hotel."},
    {name:"Treasure Island", at:[], area:"", near:["Wynn / Encore"], note:"Nothing listed at TI yet. Closest: Wynn / Encore, about a 10–15 min walk."},
    {name:"Westgate", at:["Westgate"], area:"westgate"},
    {name:"Wynn / Encore", at:["Wynn / Encore"], area:"northstrip"}
  ];
  /* RE+ hotels first, then any other hotel we have places for (customers outside the block) */
  function hotelList(){
    const covered = new Set(HOUSING.flatMap(h=>h.at));
    const others = new Map();
    for(const n of state.nearby){
      const h = hotelName(n); if(!h || NOT_HOTELS.test(h) || covered.has(h) || others.has(h)) continue;
      others.set(h, {name:h, at:[h], area:n.area});
    }
    return {
      block: HOUSING,
      others: [...others.values()].sort((a,b)=>a.name.localeCompare(b.name))
    };
  }
  /* Rough lobby-to-restaurant walk estimates for "Near a hotel".
     Each hotel sits on one street (the Strip or Paradise Rd) at its street address, on the east or west
     side. Walk ≈ 4 min per 100 address numbers + crossing the street (Strip bridges ~5 min, Paradise
     signal ~2) + the walk inside the destination hotel (+ half of it to get out of the origin hotel).
     Estimates only: the Map button shows Google's walking route from the hotel. */
  const HOTEL_GEO = {
    "Caesars Palace":{st:"strip", addr:3570, side:"W", inner:8, q:"Caesars Palace, 3570 S Las Vegas Blvd, Las Vegas, NV"},
    "Courtyard LVCC":{st:"paradise", addr:3275, side:"W", inner:2, q:"Courtyard by Marriott Las Vegas Convention Center, 3275 Paradise Rd, Las Vegas, NV"},
    "Embassy Suites Convention Center":{st:"paradise", addr:3600, side:"E", inner:2, q:"Embassy Suites Convention Center, 3600 Paradise Rd, Las Vegas, NV"},
    "Flamingo":{st:"strip", addr:3555, side:"E", inner:4, q:"Flamingo Las Vegas, 3555 S Las Vegas Blvd, Las Vegas, NV"},
    "Fontainebleau":{st:"strip", addr:2777, side:"E", inner:5, q:"Fontainebleau Las Vegas, 2777 S Las Vegas Blvd, Las Vegas, NV"},
    "Harrah's":{st:"strip", addr:3475, side:"E", inner:4, q:"Harrah's Las Vegas, 3475 S Las Vegas Blvd, Las Vegas, NV"},
    "Horseshoe Las Vegas":{st:"strip", addr:3645, side:"E", inner:4, q:"Horseshoe Las Vegas, 3645 S Las Vegas Blvd, Las Vegas, NV"},
    "Las Vegas Marriott":{st:"paradise", addr:3300, side:"W", inner:2, q:"Las Vegas Marriott, 325 Convention Center Dr, Las Vegas, NV"},
    "Mardi Gras Hotel":{st:"paradise", addr:3500, side:"E", inner:2, q:"Mardi Gras Hotel & Casino, 3500 Paradise Rd, Las Vegas, NV"},
    "MGM Grand":{st:"strip", addr:3799, side:"E", inner:7, q:"MGM Grand, 3799 S Las Vegas Blvd, Las Vegas, NV"},
    "Peppermill":{st:"strip", addr:2985, side:"E", inner:1, q:"Peppermill Restaurant, 2985 S Las Vegas Blvd, Las Vegas, NV"},
    "Paris Las Vegas":{st:"strip", addr:3655, side:"E", inner:5, q:"Paris Las Vegas, 3655 S Las Vegas Blvd, Las Vegas, NV"},
    "Renaissance Las Vegas":{st:"paradise", addr:3400, side:"E", inner:2, q:"Renaissance Las Vegas Hotel, 3400 Paradise Rd, Las Vegas, NV"},
    "Residence Inn LVCC":{st:"paradise", addr:3225, side:"W", inner:2, q:"Residence Inn Las Vegas Convention Center, 3225 Paradise Rd, Las Vegas, NV"},
    "Resorts World":{st:"strip", addr:3000, side:"W", inner:5, q:"Resorts World Las Vegas, 3000 S Las Vegas Blvd, Las Vegas, NV"},
    "SAHARA":{st:"strip", addr:2535, side:"E", inner:4, q:"SAHARA Las Vegas, 2535 S Las Vegas Blvd, Las Vegas, NV"},
    "SpringHill Suites LVCC":{st:"paradise", addr:2989, side:"W", inner:2, q:"SpringHill Suites Las Vegas Convention Center, 2989 Paradise Rd, Las Vegas, NV"},
    "The LINQ":{st:"strip", addr:3535, side:"E", inner:4, q:"The LINQ Hotel, 3535 S Las Vegas Blvd, Las Vegas, NV"},
    "The Vanderpump Hotel":{st:"strip", addr:3595, side:"E", inner:3, q:"The Vanderpump Hotel, 3595 S Las Vegas Blvd, Las Vegas, NV"},
    "Treasure Island":{st:"strip", addr:3300, side:"W", inner:4, q:"Treasure Island, 3300 S Las Vegas Blvd, Las Vegas, NV"},
    "Westgate":{st:"paradise", addr:3000, side:"E", inner:4, q:"Westgate Las Vegas, 3000 Paradise Rd, Las Vegas, NV"},
    "Wynn / Encore":{st:"strip", addr:3131, side:"E", inner:6, q:"Wynn Las Vegas, 3131 S Las Vegas Blvd, Las Vegas, NV"}
  };
  const geoOf = name => HOTEL_GEO[name] || HOTEL_GEO[String(name).replace(/ \(.*\)$/, "")] || null;
  /* Extra walk for places deeper inside their hotel than its nearest restaurant (e.g. Battista's behind the LINQ) */
  function deeper(n){
    const h = hotelName(n);
    const ins = state.nearby.filter(x=>hotelName(x)===h).map(x=>Number(x.insideMin)).filter(Number.isFinite);
    return ins.length && Number.isFinite(Number(n.insideMin)) ? Math.max(0, Number(n.insideMin) - Math.min(...ins)) : 0;
  }
  /* Estimated walk in minutes from a hotel's lobby to restaurant n, or null if we can't say */
  function walkFrom(hotel, n){
    const o = geoOf(hotel.name), d = geoOf(hotelName(n));
    if(!o || !d || o.st !== d.st) return null;
    const same = hotel.at.includes(hotelName(n));
    const street = same ? 0 : Math.abs(o.addr - d.addr) * 0.04 + (o.side !== d.side ? (o.st==="strip" ? 5 : 2) : 0) + o.inner / 2;
    return Math.max(2, Math.round(street + d.inner + deeper(n)));
  }
  const bkRank = {"Reservable":0,"Unconfirmed":1,"Walk-in":2,"Grab-and-go":3};
  const closest = (a,b)=>(Number(a.total)||99)-(Number(b.total)||99) || (bkRank[a.booking]??4)-(bkRank[b.booking]??4) || String(a.name).localeCompare(String(b.name));
  function viewNearby(){
    const zone = state.zone==="hotel" ? "hotel" : "lvcc";
    const mode = MEALS.some(m=>m[0]===state.nearMode) ? state.nearMode : "Breakfast";
    const zones = ZONES.map(([k,label,sub])=>`<button type="button" class="zoneb" data-zone="${k}" aria-pressed="${zone===k}"><b>${label}</b><span>${sub}</span></button>`).join("");
    const seg = MEALS.map(([k])=>`<button class="segb" data-near="${k}" aria-pressed="${mode===k}">${k}</button>`).join("");
    const hl = state.nearLoaded ? hotelList() : {block:[], others:[]};
    const hotel = [...hl.block, ...hl.others].find(h=>h.name===state.hotel) || null;
    const opt = h => `<option${hotel && hotel.name===h.name?" selected":""}>${esc(h.name)}</option>`;
    const picker = zone==="hotel"
      ? `<label class="hotelpick"><span>Customer’s hotel</span><select id="fl_hotel"><option value="">Choose a hotel…</option>`
        + `<optgroup label="RE+ hotels">${hl.block.map(opt).join("")}</optgroup>`
        + (hl.others.length ? `<optgroup label="Other hotels">${hl.others.map(opt).join("")}</optgroup>` : "")
        + `</select></label>`
      : "";
    let html = `<div class="zones" role="group" aria-label="Where">${zones}</div>${picker}`
      + `<div class="nearbar"><div class="seg" role="group" aria-label="Meal">${seg}</div>`
      + (state.isOwner?`<button class="btn sm" data-act="addnear">+ Add restaurant</button>`:"") + `</div>`;
    if(!state.nearLoaded) return html + `<div class="empty"><strong>Loading restaurants…</strong></div>`;
    const forMeal = state.nearby.filter(n=>Array.isArray(n.fit) && n.fit.includes(mode));
    const unit = mode==="Breakfast" ? "from the restaurant to Central Hall" : "from the booth to the table";

    if(zone==="lvcc"){
      const items = forMeal.filter(n=>NEAR_LVCC.has(n.area)).sort(closest);
      if(!items.length) return html + `<div class="empty">No ${esc(mode.toLowerCase())} spots near LVCC yet.</div>`;
      html += `<div class="near">${items.map(n=>nearCard(n, mode)).join("")}</div>`;
    } else {
      if(!hotel) return html + `<div class="empty"><strong>Pick your customer’s hotel</strong> to see ${esc(mode.toLowerCase())} spots in it or next door.</div>`;
      const ar = state.areas.find(a=>a.id===hotel.area);
      const w = n => walkFrom(hotel, n);
      const byWalk = (a,b)=>(w(a)??99)-(w(b)??99) || closest(a,b);
      const at = forMeal.filter(n=>hotel.at.includes(hotelName(n))).sort(byWalk);
      const near = (hotel.near
        ? forMeal.filter(n=>hotel.near.includes(hotelName(n)))
        : forMeal.filter(n=>n.area===hotel.area && !hotel.at.includes(hotelName(n)))).sort(byWalk);
      const walks = list => { const t = list.map(w).filter(v=>v!=null); if(!t.length) return ""; const lo=Math.min(...t), hi=Math.max(...t); return (lo===hi?`≈${lo}`:`≈${lo}–${hi}`) + " min walk"; };
      const card = n => nearCard(n, mode, {mins: w(n), from: hotel.name});
      const sec = (title, list) => `<section class="hotel"><h3 class="hotelh">${esc(title)}${walks(list)?` <span>· ${esc(walks(list))}</span>`:""}</h3><div class="near">${list.map(card).join("")}</div></section>`;
      const meta = [hotel.note || "", MONORAIL[hotel.area] || "", ar && ar.f1Risk ? "F1 zone Thu" : ""].filter(Boolean).join(" · ");
      if(meta) html += `<p class="hotelmeta">${esc(meta)}</p>`;
      if(!at.length && !near.length) return html + `<div class="empty">No ${esc(mode.toLowerCase())} spots at or near ${esc(hotel.name)} yet. Try another meal.</div>`;
      if(at.length) html += sec(`At ${hotel.name}`, at);
      if(near.length) html += sec(at.length ? "Next door" : "Nearby", near);
    }
    html += zone==="hotel"
      ? `<p class="note">Walk times are estimates from the hotel lobby; tap Map for Google’s walking route. Hours and booking policies are from October 2026 listings; call to confirm.</p>`
      : `<p class="note">Minutes are ${unit}. Hours and booking policies are estimates (October 2026); call to confirm.</p>`;
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
  let mapPlace = null, mapFrom = "lvcc", mapMorning = false, mapHotel = null;
  function drawMap(){
    const n = mapPlace; if(!n) return;
    const place = [n.name, n.venue, "Las Vegas, NV"].filter(Boolean).join(", ");
    /* Daytime: Central Hall (or The LINQ) -> restaurant. Breakfast: restaurant -> Central Hall, or The LINQ -> restaurant. */
    const hotelQ = mapHotel ? ((geoOf(mapHotel.name) || {}).q || mapHotel.name + ", Las Vegas, NV") : "";
    const [from, to] = mapFrom==="hotel" ? [hotelQ, place]
      : mapMorning
      ? (mapFrom==="linq" ? [ORIGINS.linq.q, place] : [place, ORIGINS.lvcc.q])
      : [ORIGINS[mapFrom].q, place];
    const walk = mapFrom==="hotel" ? true : mapFrom==="linq" ? n.area==="linq" : WALK_AREAS.has(n.area);
    $("#mapFrame").src = state.mapsKey
      ? "https://www.google.com/maps/embed/v1/directions?" + new URLSearchParams({key:state.mapsKey, origin:from, destination:to, mode: walk?"walking":"transit"})
      : "https://maps.google.com/maps?" + new URLSearchParams({saddr:from, daddr:to, ...(walk?{dirflg:"w"}:{}), output:"embed"});
    $("#mapOpen").href = "https://www.google.com/maps/dir/?" + new URLSearchParams({api:"1", origin:from, destination:to, travelmode: walk?"walking":"transit"});
    document.querySelectorAll("#mapDlg [data-from]").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.from===mapFrom)));
    const ar = state.areas.find(x=>x.id===n.area);
    if(mapFrom==="hotel"){
      const m = walkFrom(mapHotel, n);
      $("#mapNote").textContent = `Walking route from ${mapHotel.name}.` + (m!=null ? ` Our estimate was about ${m} min; Google’s time above is the one to trust.` : "");
      return;
    }
    $("#mapNote").textContent = mapMorning
      ? (mapFrom==="linq"
          ? `From the team hotel to breakfast; then ${n.total ? n.total+" min" : "a short trip"} on to Central Hall.` + (ar && ar.getThere && ar.getThere!=="Already there" ? " " + ar.getThere : "")
          : (n.route ? "Same route in reverse: " + n.route : ""))
      : mapFrom==="lvcc" && n.route ? "How the team gets there: " + n.route
      : ar && ar.getThere && ar.getThere!=="Already there" ? ar.getThere : "";
  }
  function openMap(n){
    /* From "Near a hotel", start at the customer's hotel */
    mapHotel = state.tab==="nearby" && state.zone==="hotel" ? (HOUSING.find(h=>h.name===state.hotel) || (state.hotel ? {name:state.hotel, at:[state.hotel]} : null)) : null;
    mapPlace = n; mapFrom = mapHotel ? "hotel" : "lvcc";
    mapMorning = !mapHotel && state.tab==="nearby" && state.nearMode==="Breakfast";
    const hb = $("#mapDlg [data-from=hotel]");
    hb.hidden = !mapHotel; if(mapHotel) hb.textContent = mapHotel.name;
    $("#mapRouteLabel").textContent = mapMorning ? "Morning route" : "Route from";
    $("#mapDlg [data-from=lvcc]").textContent = mapMorning ? "To Central Hall" : "Central Hall";
    $("#mapDlg [data-from=linq]").textContent = mapMorning ? "From The LINQ" : "The LINQ";
    $("#mapTitle").textContent = n.name;
    const wm = mapHotel ? walkFrom(mapHotel, n) : null;
    $("#mapSub").textContent = [mapHotel ? (wm!=null ? `≈${wm} min walk from ${mapHotel.name}` : "") : n.total ? n.total + (mapMorning ? " min to Central Hall" : " min from your booth") : "", n.venue].filter(Boolean).join(" · ");
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
  $("#summary").addEventListener("click", async e=>{
    if(e.target.closest("[data-act=load-updates]")){
      state.updates = {...state.updates, busy:true}; renderSummary();
      try{
        const r = await fetch("/api/updates", {method:"POST", credentials:"same-origin", cache:"no-store"});
        if(!r.ok) throw new Error("HTTP "+r.status);
        const {places, added} = await r.json();
        state.updates = {pending:0, areas:0, names:[], msg: places ? `Added ${places} new place${places===1?"":"s"}.` : `Added ${added} new area${added===1?"":"s"}.`};
      }catch(_){ state.updates = {...state.updates, busy:false, failed:true}; }   /* keep a retry button */
      await loadAll(); renderSummary();
      return;
    }
    if(!e.target.closest("[data-goto]")) return; state.tab="bookings"; remember("tab", state.tab); state.showOff=false; state.mine=false; render(); $("#view").scrollIntoView({block:"start"}); });
  $("#tabs").addEventListener("click", e=>{ const b=e.target.closest(".tab"); if(!b) return; state.tab=b.dataset.tab; remember("tab", state.tab); state.confirmDel=null; render(); });
  $("#view").addEventListener("change", async e=>{
    const t = e.target;
    if(t.id==="fl_mine"){ state.mine=t.checked; remember("mine", state.mine); render(); }
    else if(t.id==="fl_hotel"){ state.hotel=t.value; remember("hotel", state.hotel); render(); }
    else if(t.id==="fl_off"){ state.showOff=t.checked; render(); }
    else if(t.id==="fl_today"){ state.todayOnly=t.checked; render(); }
    else if(t.dataset.act==="status" && state.db && state.isOwner){
      try{ await state.db.collection("reservations").doc(t.dataset.id).update({status:t.value, updatedAt:new Date().toISOString()}); }
      catch(err){ state.err="Status change didn’t save. Try again."; render(); }
    }
  });
  $("#view").addEventListener("click", async e=>{
    const sb = e.target.closest("[data-near]");
    if(sb){ state.nearMode = sb.dataset.near; render(); return; }
    const zb = e.target.closest("[data-zone]");
    if(zb){ state.zone = zb.dataset.zone; remember("zone", state.zone); render(); return; }
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
    if(state.isOwner){ try{ const u = await apiCallRaw("/api/updates"); if(u && (u.pending || u.areas)){ state.updates = {pending:u.pending||0, areas:u.areas||0, names:u.names||[]}; renderSummary(); } }catch(_){} }
    try{ const c = await apiCallRaw("/api/config"); state.mapsKey = (c && c.mapsEmbedKey) || ""; }catch(_){}   /* optional: keyless map if missing */
    setInterval(loadAll, 30000);           /* pick up changes made on other devices */
    setInterval(()=>{ if(state.loaded && $("#formPanel").hidden && $("#nearPanel").hidden) render(); }, 10*60*1000);
  })();
})();
