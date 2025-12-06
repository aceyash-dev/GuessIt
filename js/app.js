// js/app.js
// Single shared BGM manager + dedupe of tracks
// Designed to be loaded after the page's inline script so it can hook/override audio functions.
//
// Usage: include <script src="js/app.js"></script> after the inline script in index.html.
//
// Goals:
// - Prevent overlapping playback from multiple <audio> tags by using one Audio() instance
// - Deduplicate tracks by source
// - Keep state.settings.bgm, volume and music ON/OFF in sync with the UI
// - Update the UI labels (musicLabel & stMusic) and persist via saveData() if available

(function () {
  if (typeof window === 'undefined') return;
  document.addEventListener('DOMContentLoaded', () => {
    try {
      const WIN = window;
      // Grab existing audio tags which were previously inlined
      const audioEls = Array.from(document.querySelectorAll('audio[id^="bgMusic_"]'));
      if (!audioEls.length) {
        console.warn('[BGM] No bgMusic_ audio elements found — skipping manager init.');
      }

      // Build track list from audio elements and settings select options
      const selectEl = document.getElementById('bgmSelect');
      const optionMap = {};
      if (selectEl) {
        Array.from(selectEl.options).forEach(opt => { optionMap[opt.value] = opt.textContent.trim(); });
      }

      // Build initial tracks array from existing audio elements
      let tracks = audioEls.map(el => {
        const idPart = (el.id || '').split('_')[1] || '';
        const sourceEl = el.querySelector('source');
        const src = (sourceEl && sourceEl.src) ? sourceEl.src : (el.currentSrc || el.src || '');
        const title = optionMap[idPart] || `Track ${idPart}`;
        return { id: idPart, src: src, title: title, el };
      });

      // Dedupe tracks by src (preserve first seen)
      const dedupeBySrc = (arr) => {
        const seen = new Set();
        const out = [];
        for (const t of arr) {
          const key = t.src || ('id:' + t.id);
          if (!seen.has(key) && key) {
            seen.add(key);
            out.push(t);
          }
        }
        return out;
      };

      tracks = dedupeBySrc(tracks);

      // If deduping removed entries, rebuild the settings select so it doesn't show duplicates
      if (selectEl) {
        // Save current selection
        const prevVal = selectEl.value;
        selectEl.innerHTML = '';
        tracks.forEach(t => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.title || `Track ${t.id}`;
          selectEl.appendChild(opt);
        });
        // Try to restore previous selection if still available, otherwise pick first
        selectEl.value = tracks.find(t => t.id === prevVal) ? prevVal : (tracks[0] ? tracks[0].id : '');
      }

      // Hide original audio elements and ensure they are paused
      audioEls.forEach(a => {
        try {
          a.pause();
          a.currentTime = 0;
          // visually hide to avoid duplicates in DOM
          a.style.display = 'none';
        } catch (e) {
          /* ignore */
        }
      });

      // Create shared audio player
      const bgmPlayer = new Audio();
      bgmPlayer.loop = true;
      bgmPlayer.preload = 'auto';
      bgmPlayer.crossOrigin = 'anonymous';

      // Internal state
      let currentId = null;
      let isPlaying = false;

      // Helpers to access global state/saveData if available
      const getState = () => (WIN.state || {});
      const callSave = () => { if (typeof WIN.saveData === 'function') WIN.saveData(); };

      // UI elements
      const labelEl = document.getElementById('musicLabel');
      const stMusicEl = document.getElementById('stMusic');

      function setUIPlaying(track) {
        if (labelEl) labelEl.innerText = track ? (track.title || track.src.split('/').pop()) : 'None';
        if (stMusicEl) stMusicEl.innerText = isPlaying ? 'ON' : 'OFF';
      }

      function findTrackById(id) {
        return tracks.find(t => t.id === ('' + id)) || null;
      }

      function playTrackById(id) {
        const track = findTrackById(id);
        if (!track || !track.src) {
          stop();
          currentId = null;
          setUIPlaying(null);
          return;
        }

        // If same track and already playing, do nothing
        if (currentId === track.id && isPlaying) return;

        // Stop any previous playback
        try { bgmPlayer.pause(); } catch (e) {}

        // Set source and play
        bgmPlayer.src = track.src;
        bgmPlayer.load();

        const desiredVolume = (getState().settings && typeof getState().settings.volume !== 'undefined') ? getState().settings.volume : 0.5;
        bgmPlayer.volume = Number(desiredVolume) || 0.5;

        bgmPlayer.play().then(() => {
          currentId = track.id;
          isPlaying = true;
          setUIPlaying(track);
        }).catch(err => {
          // Play may be blocked until user gesture
          console.warn('[BGM] play prevented:', err);
          isPlaying = false;
          setUIPlaying(null);
        });
      }

      function stop() {
        try {
          bgmPlayer.pause();
          bgmPlayer.currentTime = 0;
        } catch (e) {}
        isPlaying = false;
        currentId = null;
        setUIPlaying(null);
      }

      function setVolume(v) {
        const vol = Number(v);
        if (!isNaN(vol)) bgmPlayer.volume = Math.max(0, Math.min(1, vol));
      }

      // Hook into global functions (override existing implementations safely)
      // Provide new implementations for: initAudio, updateAudioState, changeBGM, changeVol, toggleSetting
      WIN.initAudio = function () {
        try {
          // try to resume audio context if present
          if (WIN.audioCtx && typeof WIN.audioCtx.resume === 'function') WIN.audioCtx.resume();
        } catch (e) {}
        // If music setting is enabled, start playing the selected track
        const s = getState().settings || {};
        if (s.music) {
          playTrackById(s.bgm || (tracks[0] && tracks[0].id));
        } else {
          stop();
        }
      };

      WIN.updateAudioState = function () {
        // Ensure older inlined audio tags are stopped (they were hidden but might still be playing)
        audioEls.forEach(el => { try { el.pause(); el.currentTime = 0; } catch (e) {} });

        const s = getState().settings || {};
        if (s.music) {
          // play selected bgm
          const chosen = s.bgm || (tracks[0] && tracks[0].id);
          if (chosen) playTrackById(chosen);
        } else {
          stop();
        }

        // reflect UI
        setUIPlaying(findTrackById(getState().settings && getState().settings.bgm));
        // make sure stMusic label is set
        if (stMusicEl) stMusicEl.innerText = s.music ? 'ON' : 'OFF';
      };

      WIN.changeBGM = function (v) {
        // v could be an event value or direct id
        const val = (typeof v === 'string' && v !== '') ? v : (v && v.target ? v.target.value : v);
        if (!val) return;
        const s = getState();
        if (!s.settings) s.settings = {};
        s.settings.bgm = '' + val;
        // if music is on, switch to the new track immediately
        if (s.settings.music) {
          playTrackById(s.settings.bgm);
        }
        // update UI & persist
        setUIPlaying(findTrackById(s.settings.bgm));
        callSave();
      };

      WIN.changeVol = function (v) {
        const vol = (typeof v === 'string' || typeof v === 'number') ? Number(v) : (v && v.target ? Number(v.target.value) : null);
        if (vol === null || isNaN(vol)) return;
        const s = getState();
        if (!s.settings) s.settings = {};
        s.settings.volume = vol;
        setVolume(vol);
        // If there are legacy audio tags, set their volume as well (safe no-op)
        audioEls.forEach(el => { try { el.volume = vol; } catch (e) {} });
        callSave();
      };

      // toggleSetting existed previously; override only the 'music' case to control our player
      const previousToggle = WIN.toggleSetting;
      WIN.toggleSetting = function (k) {
        if (k === 'music') {
          const s = getState();
          if (!s.settings) s.settings = {};
          s.settings.music = !Boolean(s.settings.music);
          if (s.settings.music) {
            // ensure user gesture resume if needed; some browsers require gesture
            playTrackById(s.settings.bgm || (tracks[0] && tracks[0].id));
          } else {
            stop();
          }
          if (stMusicEl) stMusicEl.innerText = s.settings.music ? 'ON' : 'OFF';
          callSave();
        } else {
          // fallback to previous implementation for other settings
          if (typeof previousToggle === 'function') previousToggle(k);
        }
      };

      // Wire select and range UI elements if present
      if (selectEl) {
        selectEl.addEventListener('change', function (ev) {
          const val = ev.target.value;
          WIN.changeBGM(val);
        });
      }

      const volSlider = document.getElementById('volSlider');
      if (volSlider) {
        volSlider.addEventListener('input', function (ev) {
          const v = ev.target.value;
          WIN.changeVol(v);
        });
      }

      // Keep UI labels in sync when audio element events happen
      bgmPlayer.addEventListener('play', () => { isPlaying = true; setUIPlaying(findTrackById(currentId)); });
      bgmPlayer.addEventListener('pause', () => { isPlaying = false; setUIPlaying(null); });
      bgmPlayer.addEventListener('ended', () => { isPlaying = false; setUIPlaying(null); });

      // Initialize volume and play state from existing state
      (function initialSync() {
        const s = getState();
        if (s && s.settings) {
          setVolume(typeof s.settings.volume !== 'undefined' ? s.settings.volume : 0.5);
          if (s.settings.music) {
            playTrackById(s.settings.bgm || (tracks[0] && tracks[0].id));
          } else {
            stop();
            if (stMusicEl) stMusicEl.innerText = 'OFF';
          }
        } else {
          // default UI
          setUIPlaying(null);
        }
      })();

      // Expose a lightweight API for debugging in console
      WIN.__BGM = {
        playById: playTrackById,
        stop,
        setVolume,
        tracks: tracks.slice()
      };

      console.info('[BGM] Manager initialized. Tracks:', tracks.map(t => ({ id: t.id, src: t.src, title: t.title })));
    } catch (err) {
      console.error('[BGM] Failed to initialize manager', err);
    }
  });
})();
