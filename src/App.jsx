import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = "7e343098a3de4cf19ccf5ea82d3b086a";
const REDIRECT_URI = "https://syncgroove.vercel.app/";
const SCOPES = ["streaming","user-read-email","user-read-private","user-read-playback-state","user-modify-playback-state"].join(" ");
// ⚠️ After deploying backend to Render, replace this with your Render WebSocket URL
// e.g. "wss://syncgroove-backend.onrender.com"
const WS_URL = "wss://syncgroove-backend.onrender.com";

// ─── SPOTIFY AUTH ────────────────────────────────────────────────────────────
function genVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g,"").slice(0,43);
}
async function genChallenge(v) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
async function loginWithSpotify() {
  const v = genVerifier();
  const c = await genChallenge(v);
  localStorage.setItem("sp_verifier", v);
  const p = new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, scope: SCOPES, code_challenge_method: "S256", code_challenge: c });
  window.location = `https://accounts.spotify.com/authorize?${p}`;
}
async function fetchToken(code) {
  const v = localStorage.getItem("sp_verifier");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: v }),
  });
  const data = await res.json();
  console.log("[SyncGroove] token response:", data);
  return data;
}
async function spAPI(token, path, method="GET", body) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmt = (ms) => { const s=Math.floor(ms/1000); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; };
const randId = () => Math.random().toString(36).slice(2,8).toUpperCase();

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  // Auth
  const [token, setToken] = useState(localStorage.getItem("sp_token")||"");
  const [spotifyUser, setSpotifyUser] = useState(null);

  // Room
  const [screen, setScreen] = useState("home"); // home | room
  const [roomId, setRoomId] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [members, setMembers] = useState([]);

  // Playback
  const [deviceId, setDeviceId] = useState("");
  const [track, setTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [duckVol, setDuckVol] = useState(1);

  // Voice
  const [micActive, setMicActive] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [talkingUsers, setTalkingUsers] = useState(new Set());

  // Chat
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [showChat, setShowChat] = useState(false);
  const [unread, setUnread] = useState(0);

  // UI
  const [tab, setTab] = useState("now");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [wsStatus, setWsStatus] = useState("disconnected");

  // Refs
  const wsRef = useRef(null);
  const playerRef = useRef(null);
  const analyserRef = useRef(null);
  const micStreamRef = useRef(null);
  const duckTimerRef = useRef(null);
  const animRef = useRef(null);
  const progressRef = useRef(null);
  const chatEndRef = useRef(null);
  const displayName = useRef("Guest");

  // ── SPOTIFY AUTH CALLBACK ──
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    if (code && !token) {
      const verifier = localStorage.getItem("sp_verifier");
      if (!verifier) {
        // Verifier missing — clear the bad URL and let them try again cleanly
        const u = new URL(window.location);
        u.searchParams.delete("code");
        u.searchParams.delete("state");
        window.history.replaceState({}, "", u);
        setError("Login session expired. Please click Connect Spotify again.");
        return;
      }
      fetchToken(code).then(d => {
        if (d.access_token) {
          localStorage.setItem("sp_token", d.access_token);
          setToken(d.access_token);
          const u = new URL(window.location);
          u.searchParams.delete("code");
          window.history.replaceState({}, "", u);
        } else {
          setError(`Spotify error: ${d.error_description || d.error || "unknown"}`);
        }
      });
    }
  }, []);

  // ── FETCH SPOTIFY USER ──
  useEffect(() => {
    if (!token) return;
    spAPI(token, "/me").then(u => {
      if (u?.display_name) {
        setSpotifyUser(u);
        displayName.current = u.display_name;
      }
    });
  }, [token]);

  // ── SPOTIFY SDK ──
  useEffect(() => {
    if (!token) return;
    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: "SyncGroove", getOAuthToken: cb => cb(token), volume: 1,
      });
      player.addListener("ready", ({ device_id }) => setDeviceId(device_id));
      player.addListener("authentication_error", () => { localStorage.removeItem("sp_token"); setToken(""); });
      player.addListener("player_state_changed", state => {
        if (!state) return;
        const t = state.track_window.current_track;
        setTrack(t);
        setIsPlaying(!state.paused);
        setProgress(state.position);
        setDuration(state.duration);
        // Broadcast to room if host
        if (wsRef.current?.readyState === 1 && isHost) {
          wsRef.current.send(JSON.stringify({
            type: "playback",
            isPlaying: !state.paused,
            trackUri: t?.uri,
            trackName: t?.name,
            artistName: t?.artists?.map(a=>a.name).join(", "),
            albumArt: t?.album?.images?.[0]?.url,
            position: state.position,
          }));
        }
      });
      player.connect();
      playerRef.current = player;
    };
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    document.body.appendChild(s);
    return () => { playerRef.current?.disconnect(); };
  }, [token]);

  // ── PROGRESS TICK ──
  useEffect(() => {
    if (isPlaying) {
      progressRef.current = setInterval(() => setProgress(p => Math.min(p+250, duration)), 250);
    } else clearInterval(progressRef.current);
    return () => clearInterval(progressRef.current);
  }, [isPlaying, duration]);

  // ── WEBSOCKET ──
  const connectWS = useCallback((room, name) => {
    if (wsRef.current) wsRef.current.close();
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("connected");
      ws.send(JSON.stringify({ type: "join", roomId: room, userName: name }));
      // Keep-alive ping every 25s
      const ping = setInterval(() => { if (ws.readyState===1) ws.send(JSON.stringify({type:"ping"})); }, 25000);
      ws._ping = ping;
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "joined":
          setIsHost(msg.isHost);
          setRoomId(msg.roomId);
          setScreen("room");
          // If joiner, sync to host's current track display
          if (!msg.isHost && msg.state?.trackName) {
            setTrack({ name: msg.state.trackName, artists: [{name: msg.state.artistName}], album: { images: [{url: msg.state.albumArt}] }, uri: msg.state.trackUri });
            setIsPlaying(msg.state.isPlaying);
          }
          break;
        case "promoted":
          setIsHost(true);
          setError("You are now the host!");
          break;
        case "room_update":
          setMembers(msg.info?.members || []);
          break;
        case "playback":
          // Non-host: update track display + play on their own Spotify
          if (!isHost) {
            setTrack({ name: msg.trackName, artists: [{name: msg.artistName}], album: { images: [{url: msg.albumArt}] }, uri: msg.trackUri });
            setIsPlaying(msg.isPlaying);
            if (deviceId && msg.trackUri) {
              if (msg.isPlaying) {
                spAPI(token, `/me/player/play?device_id=${deviceId}`, "PUT", { uris: [msg.trackUri], position_ms: msg.position });
              } else {
                spAPI(token, "/me/player/pause", "PUT");
              }
            }
          }
          break;
        case "chat":
          setChat(prev => [...prev, msg]);
          if (!showChat) setUnread(u => u+1);
          break;
        case "talking":
          setTalkingUsers(prev => {
            const next = new Set(prev);
            if (msg.isTalking) next.add(msg.from); else next.delete(msg.from);
            return next;
          });
          break;
      }
    };

    ws.onclose = () => {
      setWsStatus("disconnected");
      clearInterval(ws._ping);
    };
    ws.onerror = () => setError("Connection error. Check backend URL.");
  }, [token, deviceId, isHost, showChat]);

  // ── MIC ──
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = analyser;
      setMicActive(true);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const detect = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a,b)=>a+b,0)/data.length;
        if (avg > 15) {
          setIsTalking(true);
          setDuckVol(0.2);
          playerRef.current?.setVolume(0.2);
          wsRef.current?.send(JSON.stringify({ type:"talking", isTalking: true }));
          clearTimeout(duckTimerRef.current);
          duckTimerRef.current = setTimeout(() => {
            setIsTalking(false);
            setDuckVol(1);
            playerRef.current?.setVolume(1);
            wsRef.current?.send(JSON.stringify({ type:"talking", isTalking: false }));
          }, 800);
        }
        animRef.current = requestAnimationFrame(detect);
      };
      detect();
    } catch { setError("Microphone access denied."); }
  }, []);

  const stopMic = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    micStreamRef.current?.getTracks().forEach(t=>t.stop());
    analyserRef.current = null;
    setMicActive(false); setIsTalking(false); setDuckVol(1);
    playerRef.current?.setVolume(1);
    wsRef.current?.send(JSON.stringify({ type:"talking", isTalking: false }));
  }, []);

  // ── SEARCH ──
  const doSearch = useCallback(async () => {
    if (!search.trim()||!token) return;
    const d = await spAPI(token, `/search?q=${encodeURIComponent(search)}&type=track&limit=8`);
    setResults(d?.tracks?.items||[]);
  }, [search, token]);

  // ── PLAY ──
  const playTrack = useCallback(async (uri) => {
    if (!deviceId) { setError("Spotify player not ready yet."); return; }
    await spAPI(token, `/me/player/play?device_id=${deviceId}`, "PUT", { uris: [uri] });
    setTab("now");
  }, [token, deviceId]);

  // ── SEND CHAT ──
  const sendChat = () => {
    if (!chatInput.trim()) return;
    wsRef.current?.send(JSON.stringify({ type:"chat", text: chatInput }));
    setChat(prev => [...prev, { from: displayName.current, text: chatInput, at: Date.now(), self: true }]);
    setChatInput("");
  };

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [chat]);

  const copyLink = () => {
    navigator.clipboard.writeText(`https://syncgroove.vercel.app/?room=${roomId}`);
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };

  const logout = () => { localStorage.removeItem("sp_token"); setToken(""); setScreen("home"); };

  // ════════════════════════════════════════════════════
  // SCREENS
  // ════════════════════════════════════════════════════

  // ── HOME SCREEN ──
  if (screen === "home") return (
    <div style={S.page}>
      <div style={{ textAlign:"center", paddingTop: 60 }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>🎵</div>
        <div style={{ fontSize: 26, fontWeight: 800, color:"#fff", letterSpacing:"-1px" }}>SyncGroove</div>
        <div style={{ color:"#555", fontSize: 13, marginBottom: 40 }}>Listen together. Talk freely.</div>

        {error && <ErrBox msg={error} onClose={()=>setError("")} />}

        {!token ? (
          <div>
            <div style={{ color:"#444", fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
              Redirect URI for your Spotify Dashboard:<br/>
              <code style={{ color:"#a78bfa", fontSize: 11 }}>{REDIRECT_URI}</code>
            </div>
            <Btn onClick={loginWithSpotify} color="#1DB954" textColor="#000">Connect Spotify</Btn>
            <div style={{ color:"#333", fontSize: 11, marginTop: 8 }}>Requires Spotify Premium</div>
          </div>
        ) : (
          <div style={{ maxWidth: 340, margin:"0 auto" }}>
            <div style={{ color:"#4ade80", fontSize: 12, marginBottom: 24 }}>
              ✓ Spotify connected{spotifyUser ? ` as ${spotifyUser.display_name}` : ""}
            </div>

            {/* NAME */}
            <label style={S.label}>Your name</label>
            <input style={S.input} placeholder="Enter your name..."
              value={nameInput} onChange={e=>setNameInput(e.target.value)} />

            {/* CREATE ROOM */}
            <Btn onClick={() => {
              if (!nameInput.trim()) { setError("Enter your name first"); return; }
              displayName.current = nameInput.trim();
              const id = randId();
              connectWS(id, nameInput.trim());
            }} color="#7c3aed" style={{ width:"100%", marginBottom: 12 }}>
              🎧 Create a Room
            </Btn>

            <div style={{ color:"#333", fontSize: 12, marginBottom: 12, textAlign:"center" }}>— or join existing —</div>

            {/* JOIN ROOM */}
            <input style={{ ...S.input, letterSpacing: 4, textTransform:"uppercase", textAlign:"center" }}
              placeholder="ROOM CODE" maxLength={6}
              value={roomInput} onChange={e=>setRoomInput(e.target.value.toUpperCase())} />
            <Btn onClick={() => {
              if (!nameInput.trim()) { setError("Enter your name first"); return; }
              if (!roomInput.trim()) { setError("Enter a room code"); return; }
              displayName.current = nameInput.trim();
              connectWS(roomInput.trim(), nameInput.trim());
            }} color="#1e1b36" border="#4c1d95" textColor="#a78bfa" style={{ width:"100%" }}>
              → Join Room
            </Btn>

            <div style={{ marginTop: 20 }}>
              <span onClick={logout} style={{ color:"#333", fontSize: 11, cursor:"pointer" }}>logout</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // ── ROOM SCREEN ──
  return (
    <div style={S.page}>
      {/* HEADER */}
      <header style={{ width:"100%", maxWidth:520, padding:"20px 20px 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:17, fontWeight:700, color:"#fff" }}>🎵 SyncGroove</div>
          <div style={{ fontSize:10, color: wsStatus==="connected"?"#4ade80":"#ef4444", marginTop:1 }}>
            {wsStatus==="connected" ? "● connected" : "● disconnected"}
          </div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {/* Talking users indicators */}
          {Array.from(talkingUsers).map(u=>(
            <div key={u} style={{ background:"#a78bfa22", border:"1px solid #a78bfa", borderRadius:20, padding:"3px 8px", fontSize:10, color:"#a78bfa" }}>
              🎙 {u}
            </div>
          ))}
          {/* Room badge */}
          <div onClick={copyLink} style={{ display:"flex", alignItems:"center", gap:6, background:"#141420", border:"1px solid #222", borderRadius:20, padding:"5px 10px", cursor:"pointer" }}>
            <span style={{ fontSize:9, color:"#666" }}>ROOM</span>
            <span style={{ fontSize:12, fontWeight:700, color:"#a78bfa", letterSpacing:2 }}>{roomId}</span>
            <span style={{ fontSize:10, color: copied?"#4ade80":"#444" }}>{copied?"✓":"⎘"}</span>
          </div>
          {/* Chat button */}
          <div onClick={()=>{ setShowChat(s=>!s); setUnread(0); }} style={{ position:"relative", background:"#141420", border:"1px solid #222", borderRadius:20, padding:"5px 10px", cursor:"pointer", fontSize:16 }}>
            💬
            {unread>0 && <span style={{ position:"absolute", top:-4, right:-4, background:"#a78bfa", borderRadius:"50%", width:16, height:16, fontSize:9, display:"flex", alignItems:"center", justifyContent:"center", color:"#000", fontWeight:700 }}>{unread}</span>}
          </div>
        </div>
      </header>

      {/* MEMBERS BAR */}
      <div style={{ width:"100%", maxWidth:520, padding:"8px 20px 0", display:"flex", gap:6, flexWrap:"wrap" }}>
        {members.map((m,i)=>(
          <div key={i} style={{ background: m.isHost?"#2d1b4e":"#111118", border:`1px solid ${m.isHost?"#7c3aed":"#1e1e2e"}`, borderRadius:20, padding:"3px 10px", fontSize:10, color: m.isHost?"#a78bfa":"#555" }}>
            {m.isHost?"👑 ":""}{m.name}
          </div>
        ))}
        {isHost && <div style={{ fontSize:10, color:"#2d2d4e", alignSelf:"center" }}>You are host · guests sync to you</div>}
      </div>

      <main style={{ width:"100%", maxWidth:520, padding:"12px 20px 140px", flex:1, display:"flex", gap:16 }}>
        {/* MAIN CONTENT */}
        <div style={{ flex:1, minWidth:0 }}>
          {error && <ErrBox msg={error} onClose={()=>setError("")} />}

          {/* TABS */}
          <div style={{ display:"flex", gap:4, marginBottom:16, background:"#111118", borderRadius:10, padding:4 }}>
            {[["now","Now Playing"],["search","Search"]].map(([k,l])=>(
              <button key={k} onClick={()=>setTab(k)} style={{ flex:1, background:tab===k?"#1e1b36":"transparent", color:tab===k?"#a78bfa":"#555", border:"none", borderRadius:7, padding:"7px 0", fontSize:12, fontWeight:600, cursor:"pointer" }}>{l}</button>
            ))}
          </div>

          {/* NOW PLAYING */}
          {tab==="now" && (
            <div>
              <div style={{ width:"100%", aspectRatio:"1", borderRadius:14, background:"#141420", marginBottom:16, overflow:"hidden", position:"relative",
                boxShadow: isTalking?"0 0 40px rgba(167,139,250,0.3)":"0 8px 32px rgba(0,0,0,0.5)", transition:"box-shadow 0.3s" }}>
                {track?.album?.images?.[0]?.url
                  ? <img src={track.album.images[0].url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", filter:`brightness(${0.4+duckVol*0.6})`, transition:"filter 0.4s" }} />
                  : <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", flexDirection:"column", gap:8 }}>
                      <div style={{ fontSize:48 }}>🎵</div>
                      <div style={{ color:"#333", fontSize:12 }}>{isHost?"Search a song to start":"Waiting for host..."}</div>
                    </div>
                }
                {isTalking && <div style={{ position:"absolute", bottom:10, right:10, background:"rgba(167,139,250,0.9)", borderRadius:20, padding:"4px 10px", fontSize:10, fontWeight:700, color:"#000" }}>🎙 talking</div>}
                {!isHost && <div style={{ position:"absolute", top:10, left:10, background:"rgba(0,0,0,0.6)", borderRadius:20, padding:"4px 10px", fontSize:10, color:"#888" }}>👥 synced to host</div>}
              </div>

              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:17, fontWeight:700, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{track?.name||"Nothing playing"}</div>
                <div style={{ fontSize:13, color:"#666" }}>{track?.artists?.map(a=>a.name).join(", ")||""}</div>
              </div>

              <div style={{ marginBottom:16 }}>
                <div style={{ height:3, background:"#1a1a28", borderRadius:2, marginBottom:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:duration?`${(progress/duration)*100}%`:"0%", background:"linear-gradient(90deg,#6d28d9,#a78bfa)", transition:"width 0.25s linear" }} />
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#444" }}>
                  <span>{fmt(progress)}</span><span>{fmt(duration)}</span>
                </div>
              </div>

              {/* Controls — only host can control */}
              {isHost ? (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:20, marginBottom:16 }}>
                  <CBtn onClick={()=>playerRef.current?.previousTrack()}>⏮</CBtn>
                  <CBtn onClick={()=>playerRef.current?.[isPlaying?"pause":"resume"]()} size={58} color="#7c3aed" glow={isPlaying}>{isPlaying?"⏸":"▶"}</CBtn>
                  <CBtn onClick={()=>playerRef.current?.nextTrack()}>⏭</CBtn>
                </div>
              ) : (
                <div style={{ textAlign:"center", color:"#444", fontSize:12, marginBottom:16, padding:"12px", background:"#111118", borderRadius:10 }}>
                  Only the host can control playback
                </div>
              )}

              {/* Volume duck bar */}
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:12 }}>🔊</span>
                <div style={{ flex:1, height:3, background:"#1a1a28", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${duckVol*100}%`, background:duckVol<0.5?"#a78bfa":"#2a2a4a", transition:"width 0.3s, background 0.3s" }} />
                </div>
                <span style={{ fontSize:10, color:"#333", width:30 }}>{Math.round(duckVol*100)}%</span>
              </div>
            </div>
          )}

          {/* SEARCH — only host */}
          {tab==="search" && (
            <div>
              {!isHost && (
                <div style={{ textAlign:"center", color:"#444", fontSize:12, padding:"20px", background:"#111118", borderRadius:10, marginBottom:12 }}>
                  Only the host can search and queue songs
                </div>
              )}
              {isHost && (
                <>
                  <div style={{ display:"flex", gap:8, marginBottom:14 }}>
                    <input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}
                      placeholder="Search songs..." style={{ ...S.input, margin:0, flex:1 }} />
                    <button onClick={doSearch} style={{ background:"#7c3aed", border:"none", borderRadius:10, padding:"10px 14px", color:"#fff", fontWeight:700, cursor:"pointer" }}>Go</button>
                  </div>
                  {results.map(t=>(
                    <TrackRow key={t.id} track={t} onPlay={()=>playTrack(t.uri)} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* CHAT PANEL */}
        {showChat && (
          <div style={{ width:220, display:"flex", flexDirection:"column", background:"#0e0e1a", border:"1px solid #1a1a28", borderRadius:12, overflow:"hidden", maxHeight:500, position:"sticky", top:0 }}>
            <div style={{ padding:"10px 12px", borderBottom:"1px solid #1a1a28", fontSize:12, fontWeight:600, color:"#666" }}>💬 Chat</div>
            <div style={{ flex:1, overflowY:"auto", padding:"8px 10px", display:"flex", flexDirection:"column", gap:6 }}>
              {chat.length===0 && <div style={{ color:"#333", fontSize:11, textAlign:"center", marginTop:20 }}>No messages yet</div>}
              {chat.map((m,i)=>(
                <div key={i}>
                  <div style={{ fontSize:9, color:"#444", marginBottom:2 }}>{m.self?"You":m.from}</div>
                  <div style={{ background:m.self?"#1e1b36":"#141420", borderRadius:8, padding:"6px 8px", fontSize:12, color:m.self?"#c4b5fd":"#aaa", maxWidth:"100%", wordBreak:"break-word" }}>{m.text}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div style={{ padding:"8px", borderTop:"1px solid #1a1a28", display:"flex", gap:6 }}>
              <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()}
                placeholder="Message..." style={{ ...S.input, margin:0, flex:1, fontSize:12, padding:"6px 8px" }} />
              <button onClick={sendChat} style={{ background:"#7c3aed", border:"none", borderRadius:8, padding:"6px 10px", color:"#fff", fontSize:12, cursor:"pointer" }}>→</button>
            </div>
          </div>
        )}
      </main>

      {/* VOICE BAR */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:"rgba(10,10,15,0.97)", backdropFilter:"blur(20px)", borderTop:"1px solid #18182a", padding:"12px 20px 24px" }}>
        <div style={{ maxWidth:520, margin:"0 auto", display:"flex", alignItems:"center", gap:12 }}>
          <WaveBar active={micActive} talking={isTalking} />
          <button onClick={micActive?stopMic:startMic} style={{
            width:52, height:52, borderRadius:"50%",
            background: micActive?(isTalking?"linear-gradient(135deg,#6d28d9,#a78bfa)":"#1a1730"):"#111118",
            border: micActive?"2px solid #a78bfa":"2px solid #222",
            color: micActive?"#a78bfa":"#444",
            fontSize:20, cursor:"pointer", flexShrink:0,
            boxShadow: isTalking?"0 0 24px rgba(167,139,250,0.5)":"none",
            transition:"all 0.2s",
          }}>{micActive?"🎙️":"🎤"}</button>
          <div style={{ fontSize:10, color:"#444", lineHeight:1.5 }}>
            {micActive?(isTalking?<span style={{color:"#a78bfa",fontWeight:600}}>Speaking…</span>:<span style={{color:"#4ade80"}}>● Listening</span>):"Mic off"}
            <br/><span style={{color:"#2a2a3a"}}>{members.length} in room</span>
          </div>
          <div style={{ marginLeft:"auto" }}>
            <button onClick={()=>{ wsRef.current?.close(); setScreen("home"); setRoomId(""); setMembers([]); }}
              style={{ background:"transparent", border:"1px solid #1a1a28", borderRadius:20, padding:"5px 12px", color:"#333", fontSize:11, cursor:"pointer" }}>
              Leave
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SMALL COMPONENTS ────────────────────────────────────────────────────────
function WaveBar({ active, talking }) {
  return (
    <div style={{ flex:1, display:"flex", alignItems:"center", gap:2, height:28 }}>
      {Array.from({length:18}).map((_,i)=>{
        const h = active&&talking ? 6+Math.abs(Math.sin(Date.now()/100+i*0.8))*18 : active ? 3+Math.abs(Math.sin(i*0.5))*7 : 2;
        return <div key={i} style={{ flex:1, borderRadius:2, background:active&&talking?"#a78bfa":active?"#2a2a4a":"#151520", height:`${h}px`, transition:"height 0.1s, background 0.3s" }} />;
      })}
    </div>
  );
}

function TrackRow({ track, onPlay }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid #111118" }}>
      {track.album?.images?.[2] && <img src={track.album.images[2].url} alt="" style={{ width:40, height:40, borderRadius:6, flexShrink:0 }} />}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:12, fontWeight:600, color:"#e8e8f0", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{track.name}</div>
        <div style={{ fontSize:10, color:"#555" }}>{track.artists?.map(a=>a.name).join(", ")}</div>
      </div>
      <button onClick={onPlay} style={{ background:"#7c3aed", border:"none", borderRadius:6, padding:"5px 10px", color:"#fff", fontSize:11, fontWeight:600, cursor:"pointer", flexShrink:0 }}>▶</button>
    </div>
  );
}

function Btn({ onClick, color="#7c3aed", textColor="#fff", border, children, style={} }) {
  return (
    <button onClick={onClick} style={{ background:color, border:border?`1px solid ${border}`:"none", borderRadius:50, padding:"12px 28px", color:textColor, fontWeight:700, fontSize:14, cursor:"pointer", marginBottom:8, ...style }}>
      {children}
    </button>
  );
}

function CBtn({ onClick, children, size=44, color="#1a1a28", glow=false }) {
  return (
    <button onClick={onClick} style={{ width:size, height:size, borderRadius:"50%", background:color, border:"none", color:"#ccc", fontSize:size>50?22:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:glow?"0 0 20px rgba(124,58,237,0.5)":"none", transition:"box-shadow 0.3s" }}>
      {children}
    </button>
  );
}

function ErrBox({ msg, onClose }) {
  return (
    <div style={{ background:"#1f0a0a", border:"1px solid #7f1d1d", borderRadius:10, padding:"10px 14px", marginBottom:14, color:"#fca5a5", fontSize:12, display:"flex", justifyContent:"space-between" }}>
      <span>⚠️ {msg}</span>
      <span onClick={onClose} style={{ cursor:"pointer" }}>✕</span>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const S = {
  page: { minHeight:"100vh", background:"#0a0a0f", fontFamily:"'Inter',system-ui,sans-serif", color:"#e8e8f0", display:"flex", flexDirection:"column", alignItems:"center" },
  input: { width:"100%", background:"#111118", border:"1px solid #1e1e2e", borderRadius:10, padding:"10px 14px", color:"#e8e8f0", fontSize:14, outline:"none", marginBottom:10, boxSizing:"border-box" },
  label: { display:"block", fontSize:11, color:"#555", marginBottom:4, textAlign:"left" },
};
