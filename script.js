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

    const timeSigs = (midi.header.timeSignatures || [])
      .map(ts => ({ ticks: ts.ticks, numerator: ts.timeSignature[0], denominator: ts.timeSignature[1] }))
      .sort((a, b) => a.ticks - b.ticks);
    if (timeSigs.length === 0) timeSigs.push({ ticks: 0, numerator: 4, denominator: 4 });

    let maxTick = 0;
    midi.tracks.forEach(track => {
      if (track.notes) track.notes.forEach(n => { if (n.ticks > maxTick) maxTick = n.ticks; });
    });

    if (maxTick === 0 && typeof midi.duration === "number") {
      const secondsPerTick = (60000000 / tempos[0].bpm / 1e6) / ppq;
      maxTick = Math.ceil(midi.duration / secondsPerTick);
    }

    function getTempoAtTick(tick) {
      let last = tempos[0];
      for (let i = 1; i < tempos.length; i++) {
        if (tempos[i].ticks <= tick) last = tempos[i]; else break;
      }
      return last.bpm;
    }

    function getTimeSigForTick(tick) {
      let last = timeSigs[0];
      for (let i = 1; i < timeSigs.length; i++) {
        if (timeSigs[i].ticks <= tick) last = timeSigs[i]; else break;
      }
      return last;
    }

    const beats = [];
    let prevTempo = null;

    const lastBeatIndex = Math.ceil(maxTick / ppq) + 4;
    for (let i = 0; i <= lastBeatIndex; i++) {
      const tick = i * ppq;
      const tsig = getTimeSigForTick(tick);
      if (tick > maxTick + ppq * (tsig ? tsig.numerator : 4)) break;

      const seconds = ticksToSeconds(tick, tempos, ppq);
      const ms = Math.round(seconds * 1000);

      let lastTsTick = 0;
      for (let j = 0; j < timeSigs.length; j++) if (timeSigs[j].ticks <= tick) lastTsTick = timeSigs[j].ticks; else break;
      const beatsSinceTs = Math.floor((tick - lastTsTick) / ppq);
      const measureBeatNumber = (beatsSinceTs % tsig.numerator) + 1;
      const downbeat = measureBeatNumber === 1 ? 1 : 0;

      const currentTempo = getTempoAtTick(tick);
      const tempoChanged = prevTempo === null || currentTempo !== prevTempo;
      prevTempo = currentTempo;

      beats.push({
        tick,
        ms,
        downbeat,
        tempoAtTick: tempoChanged ? currentTempo : 0
      });
    }

    return beats;
  }

  function buildLua(beats, baseFilename) {
    const safeName = baseFilename.replace(/"/g, '\\"');
    
    // Use \r\n for all line endings in the Lua script
    const firstLine = `local filename = "${safeName}"\r\n\r\n`;
    const comment = `--beatTable is beat in seconds, 1 or 0 if the beat is a down beat or not, and the tempo if the tempo has changed on that beat, otherwise zero\r\n`;
    const start = `local beatTable = {\r\n`;

    const entries = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      const secStr = formatSecondsFromMs(b.ms);
      const tempoVal = b.tempoAtTick && b.tempoAtTick !== 0 ? Math.round(b.tempoAtTick) : 0;
      entries.push(`    {${secStr},${b.downbeat},${tempoVal}}${i < beats.length - 1 ? ',' : ''}`);
    }

    const endTable = `\r\n}\r\n\r\n`;

    const luaTail = `local firstBeatSeconds = beatTable[1][1]\r\nlocal lastBeatSeconds = beatTable[#beatTable][1]\r\n\r\nlocal function CreateBeatAppearances()\r\n    local beatOneAppNum, beatOtherAppNum\r\n    for i = 1, 9999 do\r\n        if not IsObjectValid(GetObject('Appearance '..i)) then\r\n            if not beatOneAppNum then\r\n                Cmd('Store Appearance '..i..' "BeatGridOnes"')\r\n                Cmd('Set Appearance '..i..' "Color" "0.99,0.99,0.99,1"')\r\n                beatOneAppNum = i\r\n            elseif not beatOtherAppNum then\r\n                Cmd('Store Appearance '..i..' "BeatGridOthers"')\r\n                Cmd('Set Appearance '..i..' "Color" "0,0,0,1"')\r\n                break\r\n            end\r\n        end\r\n    end\r\nend\r\n\r\nlocal function DeleteGridRange(songNum,trackGroup)\r\n    local startRaw = firstBeatSeconds * 16777216\r\n    local endRaw = lastBeatSeconds * 16777216\r\n    local deletionIndexList = {}\r\n    local markerList = ObjectList('Timecode '..songNum..'.'..trackGroup..'.0.1 Thru')\r\n    if #markerList == 0 then return end --early exit if no markers \r\n    -- find all markers in between start and end \r\n    for _, marker in ipairs(markerList) do\r\n        if marker.rawstart < endRaw and marker.rawstart >= startRaw then\r\n            table.insert(deletionIndexList, marker.index)\r\n        end\r\n    end\r\n    if #deletionIndexList == 0 then return end --early exit if no markers \r\n    --delete those markers \r\n    Cmd('CD Timecode '..songNum..'.'..trackGroup..'.0')\r\n    Cmd('Delete '..table.concat(deletionIndexList, " + "))\r\n    Cmd('CD Root')\r\nend\r\n\r\n\r\nlocal function CreateBeatGrid(timecodeNum,trackGroup)\r\n    --clear out markers from current timecode track \r\n    DeleteGridRange(timecodeNum,trackGroup)\r\n    local beatOneAppearance = GetObject('Appearance "BeatGridOnes"')\r\n    local beatOtherAppearance = GetObject('Appearance "BeatGridOthers"')\r\n    --check for beat appearances and make them if they don't exist yet \r\n    if not (beatOneAppearance and beatOtherAppearance) then\r\n        CreateBeatAppearances()\r\n    end\r\n    --create markers \r\n    Cmd('CD Timecode '..timecodeNum..'.'..trackGroup..'.0') --Marker layer \r\n    local progressBarHandle = StartProgress('Creating Beat Grid')\r\n    SetProgressRange(progressBarHandle,1,#beatTable)\r\n    local tcTrack = GetObject('Timecode '..timecodeNum..'.'..trackGroup..'.0')\r\n    for i = 1, #beatTable do\r\n        Cmd('Insert') -- creates new marker at bottom of children list \r\n        local allMarkers = tcTrack:Children()\r\n        local newMarker = allMarkers[#allMarkers] -- 16777216 is 2^24. You'll find that most things under the hood of MA are 24-bit raw. \r\n        newMarker.rawstart = beatTable[i][1] * 16777216\r\n        --make the length of the marker half of a quarter note \r\n        if #beatTable == 1 then \r\n            newMarker.duration = 0.25 -- arbitrary safe default\r\n        elseif i == #beatTable then\r\n            newMarker.duration = (beatTable[i][1] - beatTable[i-1][1]) / 2\r\n        else\r\n            newMarker.duration = (beatTable[i+1][1] - beatTable[i][1]) / 2\r\n        end\r\n        newMarker.appearance = beatTable[i][2] == 1 and beatOneAppearance or beatOtherAppearance\r\n        if beatTable[i][3] ~= 0 then\r\n            newMarker.name = beatTable[i][3]\r\n        end\r\n        IncProgress(progressBarHandle,1)\r\n    end\r\n    Cmd('CD Root')\r\n    StopProgress(progressBarHandle)\r\nend\r\n\r\nfunction DeleteAllMarkers(songNum,trackGroup)\r\n    Cmd('CD Timecode '..songNum..'.'..trackGroup..'.0')\r\n    Cmd('Delete 1 Thru')\r\n    Cmd('CD Root')\r\nend\r\n\r\nlocal function UiBeatGrid()\r\n    local selectedTC = SelectedTimecode()\r\n    local selectedIndex = selectedTC and selectedTC.index or 1\r\n    local defaultCommandButtons = {\r\n        {value = 3, name = "Cancel"},\r\n        {value = 2, name = "OK"},\r\n        {value = 1, name = "Clear Grid"}\r\n    }\r\n    local inputFields = {\r\n        {order = 1, name = "Timecode Number?", value = selectedIndex, whiteFilter = "0123456789", vkPlugin = "NumericInput"},\r\n        {order = 2, name = "Track Group?", value = "1", whiteFilter = "0123456789", vkPlugin = "NumericInput"}\r\n    }\r\n    local messageTable = {\r\n        icon = "object_smart",\r\n        backColor = "Window.Plugins",\r\n        title = "Tempo Map Importer",\r\n        message = "This will apply the tempo map from file: " .. filename .. "\\r\\nAppearances will be found as 'BeatGridOnes' and 'BeatGridOthers'",\r\n        commands = defaultCommandButtons,\r\n        inputs = inputFields\r\n    }\r\n    local returnTable = MessageBox(messageTable)\r\n    local inputLocation = tonumber(returnTable.inputs["Timecode Number?"])\r\n    local inputTrackGroup = tonumber(returnTable.inputs["Track Group?"]) or 1\r\n    if returnTable.result == 3 then\r\n        --Canceled\r\n        return -- Canceled\r\n    end\r\n    if returnTable.result == 2 then\r\n        if not IsObjectValid(GetObject('Timecode '..inputLocation..'.'..inputTrackGroup)) then\r\n            return Confirm("Timecode or Track Group Doesn't Exist","Canceling",nil,false) \r\n        end\r\n        return CreateBeatGrid(inputLocation,inputTrackGroup)\r\n    end\r\n    if returnTable.result == 1 then\r\n        if Confirm("Confirm Deletion", "Delete all markers in this track?", nil, true) then\r\n            return DeleteAllMarkers(inputLocation,inputTrackGroup)\r\n        else return\r\n        end\r\n    end\r\nend\r\n\r\n-- Define what happens when a user presses on the Lua Plugin within MA3 \r\nreturn UiBeatGrid\r\n`;

    const fullLua = firstLine + comment + start + entries.join('\r\n') + endTable + luaTail;
    
    return fullLua;
  }


  function base64EncodeUnicode(str) {
    str = str.replace(/\r?\n/g, "\r\n");

    const utf8Bytes = new TextEncoder().encode(str);

    let binary = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }

    return btoa(binary);
  }

  function splitLuaIntoBase64Blocks(luaString, chunkSize = 1024) {
    // Ensure consistent CRLF endings first
    luaString = luaString.replace(/\r?\n/g, "\r\n");

    const blocks = [];
    for (let i = 0; i < luaString.length; i += chunkSize) {
      const chunk = luaString.slice(i, i + chunkSize);
      const encoded = base64EncodeUnicode(chunk);
      blocks.push(encoded);
    }

    return blocks;
  }

  function buildXmlWithLuaBase64(blocks, baseFilename) {
    const totalSize = blocks.reduce((sum, block) => sum + block.length, 0);
    const safeName = (baseFilename || "Untitled") + " Beat Importer";

    let fileContent = `            <FileContent Size="${totalSize}">\n`;
    blocks.forEach(block => {
      fileContent += `                <Block Base64="${block}"/>\n`;
    });
    fileContent += '            </FileContent>';

    return `<?xml version="1.0" encoding="UTF-8"?>
    <GMA3 DataVersion="2.3.1.1">
        <UserPlugin Name="${safeName}" Guid="E8 D2 CD 55 D4 92 10 02 8F EA DF B5 EA 2C DA 1F" Author="PJ Carruth" Version="0.0.0.0">
            <ComponentLua Guid="E8 D2 CD 55 50 D7 10 02 25 FD 30 BF 10 7D 65 1E">
    ${fileContent}
            </ComponentLua>
        </UserPlugin>
    </GMA3>`;
  }

  // --- FIXED: lightweight line ending checker (was missing after trimming) ---
  function checkLuaLineEndings(luaString) {
    const crlfCount = (luaString.match(/\r\n/g) || []).length;
    const lfCount = (luaString.match(/\n/g) || []).length - crlfCount;
    const crCount = (luaString.match(/\r/g) || []).length - crlfCount;
    console.log("LINE ENDINGS: CRLF:", crlfCount, "LF-only:", lfCount, "CR-only:", crCount);
    return crlfCount > 0;
  }

  // --- FIXED: handleParse was missing and is required by UI ---
  async function handleParse() {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Select a .mid file"); return; }
    setParsing(true);
    setRows([]);
    setFilename(file.name.replace(/\.(mid|midi)$/i, ""));

    try {
      if (typeof Midi === 'undefined') {
        throw new Error('Midi library failed to load. Please refresh the page.');
      }
      
      const ab = await readAsArrayBuffer(file);
      const midi = new Midi(ab);
      const beats = generateBeatList(midi);

      const allRows = beats.map((b, i) => ({
        idx: i + 1,
        seconds: formatSecondsFromMs(b.ms),
        downbeat: b.downbeat,
        tempoAtTick: b.tempoAtTick,
        ms: b.ms
      }));

      setRows(allRows);
      setTotalBeats(allRows.length);
      
      console.log(`Parsed ${allRows.length} total beats from MIDI file`);
      
    } catch (err) {
      console.error('Parse error:', err);
      setError(`Error: ${err.message}`);
    } finally {
      setParsing(false);
    }
  }

  function downloadXml() {
    if (!rows || rows.length === 0) return;
    
    try {
      const beats = rows.map(r => ({ ms: r.ms, downbeat: r.downbeat, tempoAtTick: r.tempoAtTick }));
      console.log(`Downloading XML with ${beats.length} total beats`);
      
      const lua = buildLua(beats, filename);
      console.log("Generated Lua, length:", lua.length);
      
      const b64 = base64EncodeUnicode(lua);
      console.log("Base64 encoded, length:", b64.length);
      
      // Check line endings before encoding (non-blocking)
      checkLuaLineEndings(lua);
      
      const blocks = splitLuaIntoBase64Blocks(lua, 1024);

      console.log(`Split into ${blocks.length} blocks`);
      
      const xml = buildXmlWithLuaBase64(blocks, filename);
      console.log("XML generated successfully");
      
      const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename || "tempo-map"} Beat Importer.xml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      
      console.log("✓ Download completed successfully");
      
    } catch (error) {
      console.error("Download error:", error);
      setError(`Download failed: ${error.message}.`);
    }
  }

  return React.createElement('div', { className: 'max-w-4xl mx-auto p-6' },
    React.createElement('h2', { className: 'text-xl font-semibold mb-3' }, 'Tempo Map MID File → MA3 Beat Grid Plugin Creator'),
    React.createElement('div', { className: 'flex gap-3 items-center mb-4' },
      React.createElement('input', { ref: fileRef, type: 'file', accept: '.mid,.midi' }),
      React.createElement('button', { onClick: handleParse, disabled: parsing }, parsing ? "Parsing..." : "Parse MIDI"),
      React.createElement('button', { onClick: downloadXml, disabled: !rows.length }, 'Download XML')
    ),
    
    error && React.createElement('div', { className: 'mb-3 text-red-600' }, error),
    
    totalBeats > 0 && React.createElement('div', { className: 'mb-3 text-green-600' }, 
      `Successfully parsed ${totalBeats} total beats from MIDI file`
    ),
    
    React.createElement('div', { className: 'mb-4' },
      React.createElement('div', { className: 'text-sm text-gray-600 mb-2' }, 
        `Preview (first 200 of ${totalBeats} total beats)`
      ),
      React.createElement('table', { className: 'w-full text-sm' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', null, '#'),
            React.createElement('th', null, 'Seconds'),
            React.createElement('th', null, 'Downbeat?'),
            React.createElement('th', null, 'Tempo Change')
          )
        ),
        React.createElement('tbody', null,
          rows.slice(0, 200).map((r, i) =>
            React.createElement('tr', { key: i },
              React.createElement('td', null, r.idx),
              React.createElement('td', null, r.seconds),
              React.createElement('td', null, r.downbeat),
              React.createElement('td', null, r.tempoAtTick ?? 0)
            )
          )
        )
      ),
      totalBeats > 200 && React.createElement('div', { className: 'text-xs text-gray-500 mt-2' }, 
        `... and ${totalBeats - 200} more beats (all will be included in the download)`
      )
    ),
    React.createElement('footer', { className: 'text-center text-gray-500 text-sm mt-8' },
  'If it breaks, hit me up @pjcarruth'
)

  );
}

if (typeof window.Midi === 'undefined') {
  console.error('Midi library not loaded. Check the external script URL.');
}

ReactDOM.render(React.createElement(MidiToMa3Xml), document.getElementById('root'));