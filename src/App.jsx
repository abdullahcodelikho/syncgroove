import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = "7e343098a3de4cf19ccf5ea82d3b086a";
const REDIRECT_URI = "https://syncgroove.vercel.app/";
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

// ─── SPOTIFY AUTH HELPERS ───────────────────────────────────────────────────
function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 43);
}
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function redirectToSpotify() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem("sp_verifier", verifier);
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location = `https://accounts.spotify.com/authorize?${params}`;
}
async function fetchToken(code) {
  const verifier = localStorage.getItem("sp_verifier");
  console.log("[SyncGroove] Token exchange starting");
  console.log("[SyncGroove] REDIRECT_URI:", REDIRECT_URI);
  console.log("[SyncGroove] verifier exists:", !!verifier);
  console.log("[SyncGroove] code:", code?.slice(0, 20) + "...");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  console.log("[SyncGroove] Token response:", JSON.stringify(data));
  return data;
}
async function spotifyAPI(token, path, method = "GET", body) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// ─── ROOM ID ────────────────────────────────────────────────────────────────
function getRoomId() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("room")) return params.get("room");
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const url = new URL(window.location);
  url.searchParams.set("room", id);
  window.history.replaceState({}, "", url);
  return id;
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────
export default function SyncGroove() {
  const [token, setToken] = useState(localStorage.getItem("sp_token") || "");
  const [deviceId, setDeviceId] = useState("");
  const [track, setTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duckVolume, setDuckVolume] = useState(1);
  const [isTalking, setIsTalking] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [roomId] = useState(getRoomId);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [queue, setQueue] = useState([]);
  const [tab, setTab] = useState("now");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [copied, setCopied] = useState(false);

  const playerRef = useRef(null);
  const analyserRef = useRef(null);
  const micStreamRef = useRef(null);
  const duckTimerRef = useRef(null);
  const progressTimer = useRef(null);
  const animFrameRef = useRef(null);
  const DUCK_LEVEL = 0.25;
  const DUCK_THRESHOLD = 15;

  // ── SPOTIFY AUTH ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && !token) {
      fetchToken(code).then((data) => {
        if (data.access_token) {
          localStorage.setItem("sp_token", data.access_token);
          setToken(data.access_token);
          const url = new URL(window.location);
          url.searchParams.delete("code");
          window.history.replaceState({}, "", url);
        } else {
          const reason = data.error_description || data.error || "Unknown error";
          setError(`Spotify auth failed: "${reason}" — Redirect URI used: ${REDIRECT_URI}`);
        }
      });
    }
  }, []);

  // ── SPOTIFY WEB PLAYBACK SDK ──
  useEffect(() => {
    if (!token) return;
    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: "SyncGroove",
        getOAuthToken: (cb) => cb(token),
        volume: 1,
      });
      player.addListener("ready", ({ device_id }) => setDeviceId(device_id));
      player.addListener("not_ready", () => setError("Spotify player went offline."));
      player.addListener("initialization_error", ({ message }) => setError("Player init error: " + message));
      player.addListener("authentication_error", () => {
        localStorage.removeItem("sp_token");
        setToken("");
        setError("Session expired. Please log in again.");
      });
      player.addListener("player_state_changed", (state) => {
        if (!state) return;
        setTrack(state.track_window.current_track);
        setIsPlaying(!state.paused);
        setProgress(state.position);
        setDuration(state.duration);
      });
      player.connect();
      playerRef.current = player;
    };
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    document.body.appendChild(script);
    return () => {
      playerRef.current?.disconnect();
      document.body.removeChild(script);
    };
  }, [token]);

  // ── PROGRESS BAR ──
  useEffect(() => {
    if (isPlaying) {
      progressTimer.current = setInterval(() => {
        setProgress((p) => Math.min(p + 250, duration));
      }, 250);
    } else clearInterval(progressTimer.current);
    return () => clearInterval(progressTimer.current);
  }, [isPlaying, duration]);

  // ── MIC + VOICE DETECTION ──
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      setMicActive(true);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const detect = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        if (avg > DUCK_THRESHOLD) {
          setIsTalking(true);
          setDuckVolume(DUCK_LEVEL);
          playerRef.current?.setVolume(DUCK_LEVEL);
          clearTimeout(duckTimerRef.current);
          duckTimerRef.current = setTimeout(() => {
            setIsTalking(false);
            setDuckVolume(1);
            playerRef.current?.setVolume(1);
          }, 800);
        }
        animFrameRef.current = requestAnimationFrame(detect);
      };
      detect();
    } catch {
      setError("Mic access denied. Please allow microphone permissions.");
    }
  }, []);

  const stopMic = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    analyserRef.current = null;
    setMicActive(false);
    setIsTalking(false);
    setDuckVolume(1);
    playerRef.current?.setVolume(1);
  }, []);

  // ── SEARCH ──
  const doSearch = useCallback(async () => {
    if (!search.trim() || !token) return;
    const data = await spotifyAPI(token, `/search?q=${encodeURIComponent(search)}&type=track&limit=8`);
    setResults(data?.tracks?.items || []);
    setTab("search");
  }, [search, token]);

  // ── PLAY TRACK ──
  const playTrack = useCallback(async (uri) => {
    if (!deviceId) { setError("Spotify player not ready yet — wait a moment and try again."); return; }
    await spotifyAPI(token, `/me/player/play?device_id=${deviceId}`, "PUT", { uris: [uri] });
    setTab("now");
  }, [token, deviceId]);

  // ── ADD TO QUEUE ──
  const addToQueue = useCallback(async (t) => {
    setQueue((q) => [...q, t]);
    await spotifyAPI(token, `/me/player/queue?uri=${encodeURIComponent(t.uri)}`, "POST");
  }, [token]);

  const togglePlay = () => playerRef.current?.[isPlaying ? "pause" : "resume"]();
  const skip = () => playerRef.current?.nextTrack();
  const prev = () => playerRef.current?.previousTrack();

  const copyLink = () => {
    const url = new URL(window.location);
    url.searchParams.set("room", roomId);
    navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const logout = () => {
    localStorage.removeItem("sp_token");
    setToken("");
    setTrack(null);
    playerRef.current?.disconnect();
  };

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a0f",
      fontFamily: "'Inter', system-ui, sans-serif", color: "#e8e8f0",
      display: "flex", flexDirection: "column", alignItems: "center",
    }}>
      {/* HEADER */}
      <header style={{
        width: "100%", maxWidth: 520, padding: "24px 20px 0",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.5px", color: "#fff" }}>
            🎵 SyncGroove
          </div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>listen together · talk freely</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "#141420", border: "1px solid #222", borderRadius: 20,
            padding: "6px 12px", cursor: "pointer",
          }} onClick={copyLink}>
            <span style={{ fontSize: 10, color: "#888" }}>ROOM</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#a78bfa" }}>{roomId}</span>
            <span style={{ fontSize: 11, color: copied ? "#4ade80" : "#555" }}>{copied ? "✓" : "⎘"}</span>
          </div>
          {token && (
            <button onClick={logout} style={{
              background: "transparent", border: "1px solid #222",
              borderRadius: 20, padding: "6px 10px", color: "#555",
              fontSize: 11, cursor: "pointer",
            }}>logout</button>
          )}
        </div>
      </header>

      <main style={{ width: "100%", maxWidth: 520, padding: "16px 20px 120px", flex: 1 }}>
        {error && (
          <div style={{
            background: "#1f0a0a", border: "1px solid #7f1d1d",
            borderRadius: 10, padding: "10px 14px", marginBottom: 16,
            color: "#fca5a5", fontSize: 13, display: "flex", justifyContent: "space-between",
          }}>
            <span>⚠️ {error}</span>
            <span onClick={() => setError("")} style={{ cursor: "pointer", color: "#f87171" }}>✕</span>
          </div>
        )}

        {/* LOGIN SCREEN */}
        {!token && (
          <div style={{ textAlign: "center", marginTop: 80 }}>
            <div style={{ fontSize: 72, marginBottom: 20 }}>🎧</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 8 }}>
              Listen together.
            </div>
            <div style={{ color: "#555", marginBottom: 8, fontSize: 14, lineHeight: 1.6 }}>
              Sync Spotify with friends and talk —<br />music ducks automatically when you speak.
            </div>
            <div style={{
              background: "#141420", border: "1px solid #1e1e30",
              borderRadius: 10, padding: "10px 16px", marginBottom: 28,
              fontSize: 12, color: "#666", display: "inline-block",
            }}>
              Redirect URI to add in Spotify Dashboard:<br />
              <code style={{ color: "#a78bfa" }}>{window.location.origin + "/"}</code>
            </div>
            <br />
            <button onClick={redirectToSpotify} style={{
              background: "#1DB954", color: "#000",
              border: "none", borderRadius: 50, padding: "14px 40px",
              fontWeight: 700, fontSize: 15, cursor: "pointer", letterSpacing: 0.3,
            }}>
              Connect with Spotify
            </button>
            <div style={{ marginTop: 12, fontSize: 11, color: "#444" }}>
              Requires Spotify Premium
            </div>
          </div>
        )}

        {token && (
          <>
            {/* TABS */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "#111118", borderRadius: 10, padding: 4 }}>
              {[["now", "Now Playing"], ["search", "Search"], ["queue", `Queue (${queue.length})`]].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} style={{
                  flex: 1, background: tab === k ? "#1e1b36" : "transparent",
                  color: tab === k ? "#a78bfa" : "#555",
                  border: "none", borderRadius: 7, padding: "8px 0",
                  fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
                }}>{l}</button>
              ))}
            </div>

            {/* NOW PLAYING */}
            {tab === "now" && (
              <div>
                <div style={{
                  width: "100%", aspectRatio: "1", borderRadius: 16,
                  background: "#141420", marginBottom: 20, overflow: "hidden", position: "relative",
                  boxShadow: isTalking ? "0 0 50px rgba(167,139,250,0.35)" : "0 8px 40px rgba(0,0,0,0.6)",
                  transition: "box-shadow 0.4s",
                }}>
                  {track?.album?.images?.[0] ? (
                    <img src={track.album.images[0].url} alt="album"
                      style={{ width: "100%", height: "100%", objectFit: "cover",
                        filter: `brightness(${0.45 + duckVolume * 0.55})`,
                        transition: "filter 0.4s ease",
                      }} />
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                      justifyContent: "center", height: "100%", gap: 12 }}>
                      <div style={{ fontSize: 64 }}>🎵</div>
                      <div style={{ color: "#444", fontSize: 13 }}>No track playing</div>
                      <div style={{ color: "#333", fontSize: 11 }}>Search a song to get started</div>
                    </div>
                  )}
                  {isTalking && (
                    <div style={{
                      position: "absolute", bottom: 14, right: 14,
                      background: "rgba(167,139,250,0.92)", borderRadius: 20,
                      padding: "5px 12px", fontSize: 11, fontWeight: 700, color: "#0a0a0f",
                    }}>🎙 talking · music dimmed</div>
                  )}
                </div>

                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 19, fontWeight: 700, color: "#fff", marginBottom: 4,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {track?.name || "Nothing playing"}
                  </div>
                  <div style={{ fontSize: 14, color: "#666" }}>
                    {track?.artists?.map((a) => a.name).join(", ") || "Search for a song below"}
                  </div>
                </div>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ height: 3, background: "#1a1a28", borderRadius: 2, marginBottom: 6, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: duration ? `${(progress / duration) * 100}%` : "0%",
                      background: "linear-gradient(90deg, #6d28d9, #a78bfa)",
                      borderRadius: 2, transition: "width 0.25s linear",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#444" }}>
                    <span>{fmtTime(progress)}</span>
                    <span>{fmtTime(duration)}</span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginBottom: 24 }}>
                  <button onClick={prev} style={ctrlBtn("#1a1a28")}>⏮</button>
                  <button onClick={togglePlay} style={{
                    ...ctrlBtn("#7c3aed"), width: 62, height: 62, fontSize: 24,
                    boxShadow: isPlaying ? "0 0 24px rgba(124,58,237,0.55)" : "none",
                    transition: "box-shadow 0.3s",
                  }}>
                    {isPlaying ? "⏸" : "▶"}
                  </button>
                  <button onClick={skip} style={ctrlBtn("#1a1a28")}>⏭</button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14 }}>🔊</span>
                  <div style={{ flex: 1, height: 4, background: "#1a1a28", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${duckVolume * 100}%`,
                      background: duckVolume < 0.5 ? "#a78bfa" : "#3a3a5c",
                      transition: "width 0.4s ease, background 0.3s",
                    }} />
                  </div>
                  <span style={{ fontSize: 11, color: "#444", width: 34 }}>{Math.round(duckVolume * 100)}%</span>
                </div>
                {isTalking && (
                  <div style={{ textAlign: "center", fontSize: 11, color: "#a78bfa", marginTop: 6 }}>
                    Music auto-dimmed while you speak
                  </div>
                )}
              </div>
            )}

            {/* SEARCH */}
            {tab === "search" && (
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && doSearch()}
                    placeholder="Search songs, artists..."
                    style={{
                      flex: 1, background: "#141420", border: "1px solid #222",
                      borderRadius: 10, padding: "10px 14px", color: "#e8e8f0",
                      fontSize: 14, outline: "none",
                    }}
                  />
                  <button onClick={doSearch} style={{
                    background: "#7c3aed", border: "none", borderRadius: 10,
                    padding: "10px 18px", color: "#fff", fontWeight: 600,
                    fontSize: 14, cursor: "pointer",
                  }}>Go</button>
                </div>
                {results.length === 0 && (
                  <div style={{ textAlign: "center", color: "#333", marginTop: 40, fontSize: 13 }}>
                    Search for songs to add them
                  </div>
                )}
                {results.map((t) => (
                  <TrackRow key={t.id} track={t}
                    onPlay={() => playTrack(t.uri)}
                    onQueue={() => addToQueue(t)} />
                ))}
              </div>
            )}

            {/* QUEUE */}
            {tab === "queue" && (
              <div>
                {queue.length === 0 ? (
                  <div style={{ textAlign: "center", color: "#333", marginTop: 40, fontSize: 13 }}>
                    Queue is empty — add songs from Search
                  </div>
                ) : (
                  queue.map((t, i) => (
                    <TrackRow key={i} track={t} onPlay={() => playTrack(t.uri)} />
                  ))
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* VOICE BAR */}
      {token && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0,
          background: "rgba(10,10,15,0.97)", backdropFilter: "blur(20px)",
          borderTop: "1px solid #18182a", padding: "14px 20px 28px",
        }}>
          <div style={{ maxWidth: 520, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
            <WaveBar active={micActive} talking={isTalking} />
            <button onClick={micActive ? stopMic : startMic} style={{
              width: 56, height: 56, borderRadius: "50%",
              background: micActive
                ? isTalking ? "linear-gradient(135deg,#6d28d9,#a78bfa)" : "#1a1730"
                : "#111118",
              border: micActive ? "2px solid #a78bfa" : "2px solid #222",
              color: micActive ? "#a78bfa" : "#444",
              fontSize: 22, cursor: "pointer", flexShrink: 0,
              boxShadow: isTalking ? "0 0 28px rgba(167,139,250,0.5)" : "none",
              transition: "all 0.25s",
            }}>
              {micActive ? "🎙️" : "🎤"}
            </button>
            <div style={{ fontSize: 11, color: "#444", textAlign: "right", lineHeight: 1.5 }}>
              {micActive
                ? isTalking
                  ? <span style={{ color: "#a78bfa", fontWeight: 600 }}>Speaking…</span>
                  : <span style={{ color: "#4ade80" }}>● Listening</span>
                : <span>Mic off</span>}
              <br />
              <span style={{ color: "#333" }}>Tap to {micActive ? "mute" : "unmute"}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WaveBar({ active, talking }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 2, height: 32 }}>
      {Array.from({ length: 20 }).map((_, i) => {
        const h = active && talking
          ? 8 + Math.abs(Math.sin(Date.now() / 100 + i * 0.8)) * 20
          : active ? 4 + Math.abs(Math.sin(i * 0.5)) * 8 : 2;
        return (
          <div key={i} style={{
            flex: 1, borderRadius: 2,
            background: active && talking ? "#a78bfa" : active ? "#3a3a5c" : "#1a1a28",
            height: `${h}px`,
            transition: "height 0.12s, background 0.3s",
          }} />
        );
      })}
    </div>
  );
}

function TrackRow({ track, onPlay, onQueue }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 0", borderBottom: "1px solid #111118",
    }}>
      {track.album?.images?.[2] && (
        <img src={track.album.images[2].url} alt=""
          style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8f0",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {track.name}
        </div>
        <div style={{ fontSize: 11, color: "#555" }}>
          {track.artists?.map((a) => a.name).join(", ")}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button onClick={onPlay} style={{
          background: "#7c3aed", border: "none", borderRadius: 6,
          padding: "6px 10px", color: "#fff", fontSize: 11,
          fontWeight: 600, cursor: "pointer",
        }}>▶ Play</button>
        {onQueue && (
          <button onClick={onQueue} style={{
            background: "transparent", border: "1px solid #2d1b5e", borderRadius: 6,
            padding: "6px 10px", color: "#7c3aed", fontSize: 11,
            fontWeight: 600, cursor: "pointer",
          }}>+ Queue</button>
        )}
      </div>
    </div>
  );
}

function ctrlBtn(bg) {
  return {
    width: 46, height: 46, borderRadius: "50%",
    background: bg, border: "none", color: "#ccc",
    fontSize: 18, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
}
