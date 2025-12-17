const { useState, useRef } = React;
const Midi = window.Midi;

function MidiToMa3Xml() {
  const fileRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [filename, setFilename] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState(null);
  const [totalBeats, setTotalBeats] = useState(0);

  function readAsArrayBuffer(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsArrayBuffer(file);
    });
  }

  function formatSecondsFromMs(ms) {
    const s = (ms / 1000).toFixed(3);
    const trimmed = s.replace(/\.?0+$/, "");
    if (trimmed === "") return "0";
    return trimmed.startsWith("0.") ? trimmed.slice(1) : trimmed;
  }

  function ticksToSeconds(ticks, tempos, ppq) {
    let seconds = 0;
    for (let i = 0; i < tempos.length; i++) {
      const cur = tempos[i];
      const next = tempos[i + 1];
      const start = cur.ticks;
      if (ticks <= start) break;
      const segEnd = next ? Math.min(next.ticks, ticks) : ticks;
      const segTicks = segEnd - start;
      const usPerQuarter = 60000000 / cur.bpm;
      const secPerTick = (usPerQuarter / 1e6) / ppq;
      seconds += segTicks * secPerTick;
      if (!next || ticks <= next.ticks) break;
    }
    return seconds;
  }

  function generateBeatList(midi) {
    const ppq = midi.header.ppq || midi.header.ppqn || 480;

    const tempos = (midi.header.tempos || [])
      .map(t => ({ ticks: t.ticks, bpm: Math.round(t.bpm) }))
      .sort((a, b) => a.ticks - b.ticks);
    if (tempos.length === 0) tempos.push({ ticks: 0, bpm: 120 });
    if (tempos[0].ticks !== 0) tempos.unshift({ ticks: 0, bpm: tempos[0].bpm });

    const timeSigs = (m
