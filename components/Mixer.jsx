"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { estimateBpmFromArrayBuffer } from "../lib/bpm";

function formatTime(seconds) {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Mixer() {
  const [tracks, setTracks] = useState([]); // { id, name, file, url, bpm, duration }
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [crossfadeSeconds, setCrossfadeSeconds] = useState(8);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [status, setStatus] = useState("");

  const audioARef = useRef(null);
  const audioBRef = useRef(null);
  const ctxRef = useRef(null);
  const gainARef = useRef(null);
  const gainBRef = useRef(null);
  const sourceARef = useRef(null);
  const sourceBRef = useRef(null);
  const usingARef = useRef(true);
  const fadeTimeoutRef = useRef(null);

  // Initialize WebAudio routing once on client
  useEffect(() => {
    if (typeof window === "undefined") return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass();
    ctxRef.current = ctx;

    const audioA = new Audio();
    audioA.crossOrigin = "anonymous";
    audioARef.current = audioA;
    const audioB = new Audio();
    audioB.crossOrigin = "anonymous";
    audioBRef.current = audioB;

    const sourceA = ctx.createMediaElementSource(audioA);
    const sourceB = ctx.createMediaElementSource(audioB);
    sourceARef.current = sourceA;
    sourceBRef.current = sourceB;

    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    gainA.gain.value = 1;
    gainB.gain.value = 0;
    gainARef.current = gainA;
    gainBRef.current = gainB;

    sourceA.connect(gainA).connect(ctx.destination);
    sourceB.connect(gainB).connect(ctx.destination);

    const onEndedA = () => scheduleNextWithCrossfade();
    const onEndedB = () => scheduleNextWithCrossfade();
    audioA.addEventListener("ended", onEndedA);
    audioB.addEventListener("ended", onEndedB);

    return () => {
      audioA.removeEventListener("ended", onEndedA);
      audioB.removeEventListener("ended", onEndedB);
      sourceA.disconnect();
      sourceB.disconnect();
      gainA.disconnect();
      gainB.disconnect();
      ctx.close();
    };
  }, []);

  const speak = useCallback((text) => {
    if (!ttsEnabled) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.02;
      utter.pitch = 1.0;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch {}
  }, [ttsEnabled]);

  const addFiles = useCallback(async (filesList) => {
    const items = Array.from(filesList || []);
    if (!items.length) return;
    setStatus("Analyzing tracks...");

    const newTracks = [];
    for (const file of items) {
      if (!file.type.startsWith("audio/")) continue;
      const url = URL.createObjectURL(file);
      const arrayBuffer = await file.arrayBuffer();
      const bpm = await estimateBpmFromArrayBuffer(arrayBuffer);
      // Get duration via temp audio element
      const tmp = document.createElement("audio");
      tmp.src = url;
      await new Promise((resolve) => {
        tmp.addEventListener("loadedmetadata", resolve, { once: true });
      });
      const duration = tmp.duration || 0;

      newTracks.push({
        id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name.replace(/\.[^/.]+$/, ""),
        file,
        url,
        bpm,
        duration,
      });
    }

    setTracks((prev) => [...prev, ...newTracks]);
    setStatus("");
  }, []);

  const autoMixOrder = useCallback(() => {
    if (tracks.length < 2) return;
    // Sort by BPM proximity, keeping current first
    const first = tracks[0];
    const rest = tracks.slice(1);
    rest.sort((a, b) => {
      const da = Math.abs((first.bpm || 120) - (a.bpm || 120));
      const db = Math.abs((first.bpm || 120) - (b.bpm || 120));
      return da - db;
    });
    setTracks([first, ...rest]);
  }, [tracks]);

  const loadTrackIntoActive = useCallback(async (index) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    await ctx.resume();

    const track = tracks[index];
    if (!track) return;

    const usingA = usingARef.current;
    const activeAudio = usingA ? audioARef.current : audioBRef.current;
    const inactiveAudio = usingA ? audioBRef.current : audioARef.current;

    // Prepare active deck
    activeAudio.src = track.url;
    activeAudio.currentTime = 0;

    // Preload next for crossfade scheduling
    const next = tracks[index + 1];
    if (next) {
      inactiveAudio.src = next.url;
      inactiveAudio.currentTime = 0;
      inactiveAudio.pause();
    }
  }, [tracks]);

  const playCurrent = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const usingA = usingARef.current;
    const gainA = gainARef.current;
    const gainB = gainBRef.current;
    const audio = usingA ? audioARef.current : audioBRef.current;

    await ctx.resume();
    const now = ctx.currentTime;
    if (usingA) {
      gainA.gain.cancelScheduledValues(now);
      gainA.gain.setValueAtTime(gainA.gain.value, now);
      gainA.gain.linearRampToValueAtTime(1, now + 0.05);
    } else {
      gainB.gain.cancelScheduledValues(now);
      gainB.gain.setValueAtTime(gainB.gain.value, now);
      gainB.gain.linearRampToValueAtTime(1, now + 0.05);
    }
    await audio.play();
    setIsPlaying(true);

    scheduleNextWithCrossfade();
  }, []);

  const pauseAll = useCallback(() => {
    audioARef.current?.pause();
    audioBRef.current?.pause();
    setIsPlaying(false);
    if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
  }, []);

  const scheduleNextWithCrossfade = useCallback(() => {
    const index = currentIndex;
    const currentTrack = tracks[index];
    if (!currentTrack) return;

    const usingA = usingARef.current;
    const activeAudio = usingA ? audioARef.current : audioBRef.current;
    const inactiveAudio = usingA ? audioBRef.current : audioARef.current;
    const gainActive = usingA ? gainARef.current : gainBRef.current;
    const gainInactive = usingA ? gainBRef.current : gainARef.current;
    const ctx = ctxRef.current;

    if (!isFinite(activeAudio.duration)) return;

    const remaining = Math.max(0, activeAudio.duration - activeAudio.currentTime);
    const fadeTime = Math.min(crossfadeSeconds, activeAudio.duration / 3);

    if (remaining <= fadeTime + 0.25) {
      // Trigger crossfade now
      const nextIndex = index + 1;
      const nextTrack = tracks[nextIndex];
      if (!nextTrack) return; // nothing to do

      inactiveAudio.currentTime = 0;
      const now = ctx.currentTime;

      // Voiceover before transition
      speak(
        `Coming up: ${nextTrack.name.replace(/[_-]/g, " ")}. ` +
          `${nextTrack.bpm ? `${nextTrack.bpm} BPM` : ""}. Enjoy the vibes!`
      );

      inactiveAudio.play();
      gainInactive.gain.cancelScheduledValues(now);
      gainInactive.gain.setValueAtTime(0, now);
      gainInactive.gain.linearRampToValueAtTime(1, now + fadeTime);

      gainActive.gain.cancelScheduledValues(now);
      gainActive.gain.setValueAtTime(gainActive.gain.value, now);
      gainActive.gain.linearRampToValueAtTime(0, now + fadeTime);

      // After fade, swap decks
      setTimeout(() => {
        try { activeAudio.pause(); } catch {}
        usingARef.current = !usingARef.current;
        setCurrentIndex(nextIndex);
        scheduleNextWithCrossfade();
      }, fadeTime * 1000 + 50);
    } else {
      if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = setTimeout(
        scheduleNextWithCrossfade,
        Math.max(0, (remaining - fadeTime - 0.2) * 1000)
      );
    }
  }, [crossfadeSeconds, currentIndex, tracks, speak]);

  const startMix = useCallback(async () => {
    if (!tracks.length) return;
    setCurrentIndex(0);
    usingARef.current = true;
    await loadTrackIntoActive(0);
    setTimeout(() => playCurrent(), 100);
  }, [tracks, loadTrackIntoActive, playCurrent]);

  const nextTrack = useCallback(async () => {
    const nextIndex = Math.min(tracks.length - 1, currentIndex + 1);
    if (nextIndex === currentIndex) return;
    usingARef.current = !usingARef.current; // force using other deck
    setCurrentIndex(nextIndex);
    await loadTrackIntoActive(nextIndex);
    await playCurrent();
  }, [currentIndex, tracks, loadTrackIntoActive, playCurrent]);

  const prevTrack = useCallback(async () => {
    const prevIndex = Math.max(0, currentIndex - 1);
    if (prevIndex === currentIndex) return;
    usingARef.current = !usingARef.current;
    setCurrentIndex(prevIndex);
    await loadTrackIntoActive(prevIndex);
    await playCurrent();
  }, [currentIndex, loadTrackIntoActive, playCurrent]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const onFileChange = useCallback((e) => {
    addFiles(e.target.files);
  }, [addFiles]);

  const totalDuration = useMemo(() => tracks.reduce((s, t) => s + (t.duration || 0), 0), [tracks]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">AI DJ ? Agentic Mixer</h1>
        <p className="text-sm text-gray-300 mt-1">On-device crossfader, BPM estimation, and DJ voiceovers.</p>
      </header>

      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="card p-6 mb-6 border-dashed border-2 border-gray-700 hover:border-violet-500 transition-colors"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="font-semibold">Add your tracks</p>
            <p className="text-sm text-gray-400">Drag & drop audio files (MP3/WAV) or use file picker.</p>
          </div>
          <label className="btn btn-primary px-4 py-2 cursor-pointer">
            <input type="file" multiple accept="audio/*" className="hidden" onChange={onFileChange} />
            Upload Files
          </label>
        </div>
        {status && <p className="text-sm text-gray-400 mt-3">{status}</p>}
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="card p-4 md:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <p className="font-semibold">Playlist ({tracks.length})</p>
            <div className="flex items-center gap-2">
              <button className="btn btn-muted px-3 py-2" onClick={autoMixOrder} disabled={!tracks.length}>Smart order</button>
              <button className="btn btn-primary px-3 py-2" onClick={startMix} disabled={!tracks.length}>Start</button>
              {isPlaying ? (
                <button className="btn btn-muted px-3 py-2" onClick={pauseAll}>Pause</button>
              ) : (
                <button className="btn btn-muted px-3 py-2" onClick={playCurrent} disabled={!tracks.length}>Play</button>
              )}
            </div>
          </div>

          <ul className="divide-y divide-gray-800">
            {tracks.map((t, i) => (
              <li key={t.id} className={`py-3 flex items-center justify-between ${i === currentIndex ? 'bg-gray-900/40' : ''} px-2 rounded` }>
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${i === currentIndex ? 'bg-violet-500' : 'bg-gray-600'}`}></div>
                  <div>
                    <p className="font-medium">{t.name}</p>
                    <p className="text-xs text-gray-400">{t.bpm ? `${t.bpm} BPM` : '?'} ? {formatTime(t.duration)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="text-xs px-2 py-1 btn btn-muted" onClick={() => {
                    const arr = [...tracks];
                    if (i <= 0) return;
                    const [it] = arr.splice(i, 1);
                    arr.splice(i - 1, 0, it);
                    setTracks(arr);
                  }}>?</button>
                  <button className="text-xs px-2 py-1 btn btn-muted" onClick={() => {
                    const arr = [...tracks];
                    if (i >= arr.length - 1) return;
                    const [it] = arr.splice(i, 1);
                    arr.splice(i + 1, 0, it);
                    setTracks(arr);
                  }}>?</button>
                  <button className="text-xs px-2 py-1 btn btn-muted" onClick={() => {
                    const arr = tracks.filter((x) => x.id !== t.id);
                    setTracks(arr);
                  }}>Remove</button>
                </div>
              </li>
            ))}
          </ul>

          {tracks.length > 0 && (
            <div className="mt-4 flex items-center gap-3">
              <button className="btn btn-muted px-3 py-2" onClick={prevTrack} disabled={currentIndex === 0}>Prev</button>
              <button className="btn btn-muted px-3 py-2" onClick={nextTrack} disabled={currentIndex >= tracks.length - 1}>Next</button>
            </div>
          )}
        </div>

        <div className="card p-4">
          <p className="font-semibold mb-3">Mixer Settings</p>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm text-gray-300">Crossfade length</label>
                <span className="text-sm text-gray-400">{crossfadeSeconds}s</span>
              </div>
              <input
                type="range"
                min={2}
                max={20}
                value={crossfadeSeconds}
                onChange={(e) => setCrossfadeSeconds(parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm text-gray-300">DJ Voiceover (TTS)</label>
              <input type="checkbox" checked={ttsEnabled} onChange={(e) => setTtsEnabled(e.target.checked)} />
            </div>

            <div className="text-xs text-gray-400">
              <p>Total length: {formatTime(totalDuration)}</p>
              <p className="mt-1">Tip: Keep BPMs close for smoother blends.</p>
            </div>
          </div>
        </div>
      </div>

      {/* hidden audio elements */}
      <audio ref={audioARef} hidden />
      <audio ref={audioBRef} hidden />
    </div>
  );
}
