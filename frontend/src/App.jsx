import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, Settings, Server, MapPin, Trash2, CheckCircle, 
  Upload, Network, Clock, FileOutput, Save, BellDot, 
  Globe, Sliders, Play, Square, Terminal, CheckSquare, Download, Target
} from 'lucide-react';
import { MapContainer, TileLayer, Popup, CircleMarker, Circle, Polygon as LeafletPolygon } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// ==========================================
// GEOMETRY ENGINE
// ==========================================
const getCameraFovPolygon = (lat, lng, radiusMeters, azimuth, fov) => {
  const R = 6371000;
  const centerLat = lat * (Math.PI / 180);
  const centerLng = lng * (Math.PI / 180);
  const points = [[lat, lng]]; 
  const startAngle = azimuth - (fov / 2);
  const endAngle = azimuth + (fov / 2);

  for (let angle = startAngle; angle <= endAngle; angle += 2) {
    const brng = angle * (Math.PI / 180);
    const pLat = Math.asin(Math.sin(centerLat) * Math.cos(radiusMeters / R) + Math.cos(centerLat) * Math.sin(radiusMeters / R) * Math.cos(brng));
    const pLng = centerLng + Math.atan2(Math.sin(brng) * Math.sin(radiusMeters / R) * Math.cos(centerLat), Math.cos(radiusMeters / R) - Math.sin(centerLat) * Math.sin(pLat));
    points.push([pLat * (180 / Math.PI), pLng * (180 / Math.PI)]);
  }
  return points;
};

// ==========================================
// MODULE 1: DEVICE CONFIGURATION
// ==========================================
const DeviceConfigView = ({ devices, setDevices, sensorSchemas, setSensorSchemas }) => {
  const [status, setStatus] = useState({ message: 'System Ready', type: 'info' });

  const syncDevicesToDB = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8000/api/config/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(devices)
      });
      if (response.ok) {
        alert("✅ SUCCESS: Sensors saved to PostgreSQL!");
        setStatus({ message: "Sensors Saved to DB", type: "success" });
      } else {
        const text = await response.text();
        alert("❌ PYTHON REJECTED THE DATA:\n" + text);
      }
    } catch (err) {
      alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message);
    }
  };

  const syncSchemasToDB = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8000/api/config/schemas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sensorSchemas)
      });
      if (response.ok) {
        alert("✅ SUCCESS: Packet Formats saved to PostgreSQL!");
        setStatus({ message: "Formats Saved to DB", type: "success" });
      } else {
        const text = await response.text();
        alert("❌ PYTHON REJECTED THE DATA:\n" + text);
      }
    } catch (err) {
      alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message);
    }
  };

  const handleSensorJsonUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        let text = e.target.result;
        text = text.replace(/(:\s*)(Point\s*\([^)]+\))/gi, '$1"$2"');
        text = text.replace(/(:\s*)(Polygon\s*\(\([\s\S]*?\)\))/gi, '$1"$2"');
        text = text.replace(/,\s*([}\]])/g, '$1'); 

        const data = JSON.parse(text);
        const dataArray = Array.isArray(data) ? data : [data];

        const isValidFormat = dataArray.every(d => d.SensorId && d.SensorType && d.geometry);
        if (!isValidFormat) {
            throw new Error("Missing required fields. Each object must have a SensorId, SensorType, and geometry.");
        }

        const parsedSensors = dataArray.map(d => {
          let lng = 0, lat = 0, isPolygon = false, polygonArr = [];
          if (typeof d.geometry === 'string') {
            if (d.geometry.toUpperCase().includes('POLYGON')) {
               isPolygon = true;
               const match = d.geometry.match(/POLYGON\s*\(\(([\s\S]+)\)\)/i);
               if (match) {
                 const pairs = match[1].split(',');
                 polygonArr = pairs.map(pair => {
                   const [plng, plat] = pair.trim().split(/\s+/);
                   return [parseFloat(plat), parseFloat(plng)];
                 });
                 if (polygonArr.length > 0) { lat = polygonArr[0][0]; lng = polygonArr[0][1]; }
               }
            } else if (d.geometry.toUpperCase().includes('POINT')) {
               const match = d.geometry.match(/Point\(\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\)/i);
               if (match) { lng = parseFloat(match[1]); lat = parseFloat(match[2]); }
            }
          }
          return {
            id: d.SensorId || `UNK_${Math.floor(Math.random()*1000)}`, type: d.SensorType || "Unknown",
            innerRange: parseFloat(d.InnerRange || 0), outerRange: parseFloat(d.OuterRange || 100),
            azimuth: parseFloat(d.Azimuth || 0), fov: parseFloat(d.FOV || 360),
            alertCount: parseInt(d.AlertCount || 0), packetChoice: d.PacketChoice || "", lat, lng, isPolygon, polygon: polygonArr
          };
        });
        
        const missingSchemas = parsedSensors
            .filter(d => d.packetChoice)
            .map(d => d.packetChoice)
            .filter(pc => !sensorSchemas.some(s => s.name.toUpperCase() === pc.toUpperCase()));

        if (missingSchemas.length > 0) {
            throw new Error(`The following Packet Formats are missing from the system: ${[...new Set(missingSchemas)].join(', ')}.\n\nPlease upload the correct Packet Format files BEFORE uploading this sensor array.`);
        }

        setDevices(prev => [...prev, ...parsedSensors]);
        setStatus({ message: `Loaded ${parsedSensors.length} Sensors. Please click 'Save to DB'.`, type: 'info' });
      } catch (err) { 
        alert(`🚨 FORMAT ERROR!\n\nThe Sensor Array file was rejected.\nDetails: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const handleSchemaUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsedData = JSON.parse(e.target.result);
        const dataArray = Array.isArray(parsedData) ? parsedData : [parsedData];
        
        const isValid = dataArray.every(item => item.protocolName && Array.isArray(item.fields));
        if (!isValid) {
            throw new Error("Missing 'protocolName' or 'fields' array. This is not a valid packet format schema.");
        }

        const schemasToAdd = dataArray.map(item => ({
            name: item.protocolName.toUpperCase(),
            separator: item.separator || ',',
            totalIndexes: item.fields.length,
            schema: item.fields
        }));
        
        setSensorSchemas(prev => [...prev, ...schemasToAdd]);
        setStatus({ message: `Loaded ${schemasToAdd.length} Protocol Schemas. Please click 'Save to DB'.`, type: 'info' });
      } catch (err) { 
        alert(`🚨 SCHEMA ERROR!\n\nYour Packet Format JSON was rejected.\nDetails: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const handleEnvironmentKmlUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parser = new DOMParser();
        const xml = parser.parseFromString(e.target.result, "text/xml");
        const placemarks = xml.querySelectorAll("Placemark");
        let parsedEnvironment = [];
        placemarks.forEach(pm => {
          const pointNode = pm.querySelector("Point coordinates");
          if (pointNode) {
            const coords = pointNode.textContent.trim().split(",");
            parsedEnvironment.push({
              id: pm.querySelector("name")?.textContent || `ENV_${Math.floor(Math.random()*1000)}`, type: "Environment", isPolygon: false,
              lat: parseFloat(coords[1]), lng: parseFloat(coords[0]), innerRange: 0, outerRange: 0, azimuth: 0, fov: 0, alertCount: 0, packetChoice: ""
            });
          }
        });
        
        setDevices(prev => [...prev, ...parsedEnvironment]);
        setStatus({ message: `Loaded ${parsedEnvironment.length} Static Markers. Please click 'Save to DB'.`, type: 'info' });
      } catch (err) { 
        alert("🚨 KML SYNTAX ERROR!");
      }
    };
    reader.readAsText(file);
  };

  const removeDevice = (id) => {
    setDevices(devices.filter(d => d.id !== id));
    fetch(`http://127.0.0.1:8000/api/config/devices/${id}`, { method: 'DELETE' }).catch(console.error);
  };

  const removeSchema = (name) => {
    setSensorSchemas(sensorSchemas.filter(s => s.name !== name));
    fetch(`http://127.0.0.1:8000/api/config/schemas/${name}`, { method: 'DELETE' }).catch(console.error);
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-2xl font-bold text-emerald-400 flex items-center space-x-2"><Settings className="w-6 h-6" /> <span>Device Configuration</span></h2>
          <p className="text-slate-400 text-sm mt-1">Upload files to memory, then permanently lock them into PostgreSQL.</p>
        </div>
        <div className={`px-4 py-2 rounded font-mono text-xs font-bold border ${status.type === 'error' ? 'bg-rose-950/50 border-rose-800 text-rose-400' : 'bg-emerald-950/50 border-emerald-800 text-emerald-400'}`}>{status.message}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center"><Target className="w-4 h-4 mr-2 text-rose-400"/> Sensor Array Input</h3>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative">
            <input type="file" accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSensorJsonUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Server className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload JSON File</p>
            <p className="text-xs text-slate-500 mt-1">Parses Points and WKT Polygons</p>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center"><Settings className="w-4 h-4 mr-2 text-fuchsia-400"/> Packet Format Input</h3>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative">
            <input type="file" accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSchemaUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Server className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload JSON Schema</p>
            <p className="text-xs text-slate-500 mt-1">Accepts multiple format objects</p>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center"><MapPin className="w-4 h-4 mr-2 text-emerald-400"/> Environment Input</h3>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative">
            <input type="file" accept=".kml" onClick={(e) => { e.target.value = null; }} onChange={handleEnvironmentKmlUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <MapPin className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload KML File</p>
            <p className="text-xs text-slate-500 mt-1">Static Buildings, Trees, Towers</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-6">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-lg flex flex-col overflow-hidden shadow-sm h-[400px]">
          <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center"><Server className="w-4 h-4 mr-2 text-indigo-400"/> Deployed Entities ({devices.length})</h3>
            <button onClick={syncDevicesToDB} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg">
              <Save className="w-4 h-4 mr-2" /> SAVE SENSORS TO DB
            </button>
          </div>
          <div className="flex-1 overflow-auto p-0">
            {devices.length === 0 ? <div className="h-full flex flex-col items-center justify-center text-slate-600 font-mono text-sm">No hardware or environment loaded.</div> : (
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-950/50 text-slate-400 font-mono text-xs sticky top-0 z-10"><tr><th className="p-3">ID / Protocol</th><th className="p-3">Location/Boundary</th><th className="p-3">Parameters</th><th className="p-3 text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-800/50">
                  {devices.map((dev, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/30">
                      <td className="p-3"><div className={`font-bold ${dev.type === 'Environment' ? 'text-emerald-400' : 'text-slate-200'}`}>{dev.id}</div><div className="text-xs text-cyan-500 uppercase">{dev.packetChoice ? `PKT: ${dev.packetChoice}` : dev.type}</div></td>
                      <td className="p-3 font-mono text-xs text-slate-400">{dev.isPolygon ? 'POLYGON (WKT)' : `${dev.lat.toFixed(4)}, ${dev.lng.toFixed(4)}`}</td>
                      <td className="p-3 font-mono text-cyan-400 text-xs">{dev.type === 'Environment' ? 'Static Marker' : dev.isPolygon ? `${dev.alertCount} Target Alerts` : `${dev.innerRange}-${dev.outerRange}m | ${dev.alertCount} Alerts`}</td>
                      <td className="p-3 text-right"><button onClick={() => removeDevice(dev.id)} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4 inline" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg flex flex-col overflow-hidden shadow-sm h-[400px]">
          <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center"><Settings className="w-4 h-4 mr-2 text-fuchsia-400"/> Packet Formats ({sensorSchemas.length})</h3>
            <button onClick={syncSchemasToDB} className="bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg">
              <Save className="w-4 h-4 mr-2" /> SAVE FORMATS TO DB
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {sensorSchemas.length === 0 ? <div className="p-10 text-center text-slate-500 font-mono text-xs">No schemas loaded.</div> : (
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="bg-slate-950/50 text-slate-400 font-mono sticky top-0"><tr><th className="p-3">Protocol Match</th><th className="p-3 text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-800/50">
                  {sensorSchemas.map((schema, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/30">
                      <td className="p-3 font-bold text-fuchsia-400">{schema.name} <span className="text-slate-500 font-normal">[{schema.separator}]</span></td>
                      <td className="p-3 text-right"><button onClick={() => removeSchema(schema.name)} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4 inline" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// MODULE 2: SCENARIO BUILDER
// ==========================================
const ScenarioBuilderView = ({ scenario, setScenario, devices }) => {
  const [status, setStatus] = useState('');
  const configurableSensors = devices.filter(d => d.type !== 'Environment');

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setScenario(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const toggleDevice = (id) => {
    setScenario(prev => {
      const isActive = prev.activeDevices.includes(id);
      return { ...prev, activeDevices: isActive ? prev.activeDevices.filter(d => d !== id) : [...prev.activeDevices, id] };
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if(scenario.activeDevices.length === 0) return alert("You must select at least one active sensor!");
    
    try {
        const response = await fetch('http://127.0.0.1:8000/api/state/scenario', { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenario) 
        });
        if (response.ok) {
            setStatus('Scenario compiled and State Saved to Database.');
            setTimeout(() => setStatus(''), 4000);
        } else {
            const text = await response.text();
            alert("❌ PYTHON REJECTED SCENARIO:\n" + text);
        }
    } catch (err) {
        alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message);
    }
  };

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-2xl font-bold text-indigo-400 flex items-center space-x-2"><Sliders className="w-6 h-6" /> <span>Scenario Builder</span></h2>
          <p className="text-slate-400 text-sm mt-1">Bind active sensors to your mission. Checkboxes and Target IP are auto-saved.</p>
        </div>
        <span className="text-emerald-400 text-sm font-mono font-bold">{status && <><CheckCircle className="w-4 h-4 inline mr-2" />{status}</>}</span>
      </div>

      <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm md:col-span-2">
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-slate-500 mb-1 uppercase tracking-wider">Mission Designation (Scenario Name)</label>
              <input type="text" name="name" required value={scenario.name} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-4 py-3 text-white text-lg font-bold focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center border-b border-slate-800 pb-2"><CheckSquare className="w-4 h-4 mr-2 text-amber-400"/> Hardware Binding</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
            {configurableSensors.length === 0 ? <div className="text-xs font-mono text-rose-400 p-3 bg-rose-950/20 border border-rose-900/50 rounded">No sensors loaded.</div> : (
              configurableSensors.map(dev => (
                <div key={dev.id} onClick={() => toggleDevice(dev.id)} className={`flex items-center justify-between p-3 rounded cursor-pointer border transition-colors ${scenario.activeDevices.includes(dev.id) ? 'bg-indigo-950/40 border-indigo-500/50' : 'bg-slate-950 border-slate-800 hover:border-slate-700'}`}>
                  <div><span className={`text-sm font-bold ${scenario.activeDevices.includes(dev.id) ? 'text-indigo-400' : 'text-slate-300'}`}>{dev.id}</span><span className="text-xs text-slate-500 ml-2 uppercase">({dev.type})</span></div>
                  <input type="checkbox" checked={scenario.activeDevices.includes(dev.id)} readOnly className="w-4 h-4 accent-indigo-500" />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center border-b border-slate-800 pb-2"><Network className="w-4 h-4 mr-2 text-cyan-400"/> Target Routing</h3>
          <div className="grid grid-cols-1 gap-4">
            <div><label className="block text-xs font-mono text-slate-500 mb-1">Target UDP IP Address</label><input type="text" name="udpIp" value={scenario.udpIp} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-cyan-400 font-mono" /></div>
            <div><label className="block text-xs font-mono text-slate-500 mb-1">Target UDP Port</label><input type="number" name="udpPort" value={scenario.udpPort} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-cyan-400 font-mono" /></div>
          </div>
        </div>

        <div className="md:col-span-2 flex justify-end"><button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-8 py-3 rounded text-sm shadow-lg"><Save className="w-4 h-4 inline mr-2" />SAVE SCENARIO ARCHITECTURE</button></div>
      </form>
    </div>
  );
};

// ==========================================
// MODULE 3: ALERT GENERATOR
// ==========================================
const AlertGeneratorView = ({ 
    devices, scenario, alertConfig, setAlertConfig, 
    simIsRunning, simLogs, simProgress, startSimulation, stopSimulation, 
    overrideCounts, setOverrideCounts, getAlertCount 
}) => {
  const activeFleet = devices.filter(d => scenario.activeDevices.includes(d.id));
  const targetTotalAlerts = activeFleet.reduce((acc, dev) => acc + getAlertCount(dev), 0);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setAlertConfig(prev => ({ ...prev, [name]: parseFloat(value) }));
  };

  const handleCountOverride = (devId, val) => {
    const num = parseInt(val, 10);
    setOverrideCounts(prev => ({ ...prev, [devId]: isNaN(num) ? 0 : num }));
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div><h2 className="text-2xl font-bold text-rose-400 flex items-center space-x-2"><BellDot className="w-6 h-6" /> <span>Alert Generator</span></h2><p className="text-slate-400 text-sm mt-1">Executing {targetTotalAlerts} total alerts across bounded sensor arrays.</p></div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="space-y-6">
          
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center border-b border-slate-800 pb-2">
              <Target className="w-4 h-4 mr-2 text-rose-400"/> Payload Overrides
            </h3>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-2 mb-5">
              {activeFleet.length === 0 ? (
                 <div className="text-xs font-mono text-slate-500 bg-slate-950 p-3 rounded border border-slate-800">No active sensors bound in scenario.</div>
              ) : (
                 activeFleet.map(dev => (
                   <div key={dev.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 p-2 rounded">
                     <div>
                       <span className="text-sm font-bold text-slate-300">{dev.id}</span>
                       <span className="text-[10px] text-slate-500 ml-2 uppercase">({dev.type})</span>
                     </div>
                     <input
                       type="number" min="0"
                       value={getAlertCount(dev)}
                       onChange={(e) => handleCountOverride(dev.id, e.target.value)}
                       disabled={simIsRunning}
                       className="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-rose-400 font-mono text-center text-sm disabled:opacity-50 focus:border-rose-500 focus:outline-none"
                     />
                   </div>
                 ))
              )}
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded px-3 py-3 text-center">
               <span className="block text-xs font-mono text-slate-500 mb-1">Target Mission Payload</span>
               <span className="text-2xl text-rose-400 font-bold">{targetTotalAlerts} Packets</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-5 flex items-center border-b border-slate-800 pb-2"><Sliders className="w-4 h-4 mr-2 text-cyan-400"/> Transmission Parameters</h3>
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-xs font-mono text-slate-500 mb-1 flex items-center"><Clock className="w-3 h-3 mr-1 text-amber-400"/> Timing Physics (Seconds)</label>
                <div className="grid grid-cols-2 gap-3">
                  <input type="number" step="0.1" name="minDelaySec" value={alertConfig.minDelaySec} onChange={handleChange} disabled={simIsRunning} placeholder="Min" className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-amber-400 font-mono disabled:opacity-50 focus:border-amber-500 focus:outline-none" />
                  <input type="number" step="0.1" name="maxDelaySec" value={alertConfig.maxDelaySec} onChange={handleChange} disabled={simIsRunning} placeholder="Max" className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-amber-400 font-mono disabled:opacity-50 focus:border-amber-500 focus:outline-none" />
                </div>
              </div>
            </div>
            <div className="mb-6">
              <div className="flex justify-between text-xs font-mono mb-1 text-slate-400"><span>Progress</span><span>{simProgress}%</span></div>
              <div className="w-full bg-slate-950 rounded-full h-2 border border-slate-800"><div className="bg-rose-500 h-full rounded-full transition-all duration-300" style={{ width: `${simProgress}%` }}></div></div>
            </div>
            {!simIsRunning ? ( <button onClick={startSimulation} className="w-full flex justify-center items-center space-x-2 bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded text-sm shadow-lg"><Play className="w-4 h-4 fill-current" /> <span>ENGAGE TRANSMITTER</span></button> ) : (
              <button onClick={stopSimulation} className="w-full flex justify-center items-center space-x-2 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded text-sm shadow-lg animate-pulse"><Square className="w-4 h-4 fill-current" /> <span>ABORT</span></button> )}
          </div>
        </div>
        <div className="xl:col-span-2">
          <div className="bg-[#0A0A0A] border border-slate-800 rounded-lg h-full flex flex-col overflow-hidden shadow-2xl relative">
            <div className="bg-slate-900 border-b border-slate-800 px-5 py-3 flex justify-between items-center z-10"><h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center font-mono"><Terminal className="w-4 h-4 mr-2 text-slate-500"/> Live UDP Telemetry</h3></div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed space-y-1">
              {simLogs.length === 0 ? <div className="text-slate-600 mt-2">Waiting for simulation to begin...</div> : simLogs.map((log, idx) => (<div key={idx} className={`flex space-x-3 ${log.type === 'error' ? 'text-rose-400' : log.type === 'info' ? 'text-cyan-400' : 'text-emerald-400'}`}><span className="opacity-50 shrink-0">[{log.time}]</span><span className="break-all">{log.msg}</span></div>))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// VIEW 4: TACTICAL MAP
// ==========================================
const MapView = ({ devices, alerts }) => {
  const mapCenter = devices.length > 0 && devices[0].lat ? [devices[0].lat, devices[0].lng] : [19.2813, 72.8693];

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto h-[calc(100vh-4rem)] flex flex-col font-sans">
      <div className="border-b border-slate-800 pb-4 flex items-center justify-between">
        <div><h2 className="text-xl font-bold text-white flex items-center space-x-2"><Globe className="w-6 h-6 text-cyan-400" /><span>Tactical Map Visualizer</span></h2></div>
        <div className="flex space-x-3"><div className="flex items-center space-x-2 bg-rose-950/40 border border-rose-900 rounded px-3 py-1"><Target className="w-4 h-4 text-rose-500" /><span className="text-xs font-mono text-rose-400 font-bold">ACTIVE THREATS: {alerts ? alerts.length : 0}</span></div></div>
      </div>
      <div className="flex-1 rounded-xl overflow-hidden border border-slate-300 shadow-2xl relative z-0">
        <MapContainer center={mapCenter} zoom={14} className="h-full w-full" style={{ background: '#f8fafc' }}>
          <TileLayer attribution='&copy; CartoDB' url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
          {devices && devices.map((dev) => (
            <React.Fragment key={dev.id}>
              {dev.type === 'Environment' && (
                <CircleMarker center={[dev.lat, dev.lng]} radius={4} pathOptions={{ color: '#475569', fillColor: '#94a3b8', fillOpacity: 1, weight: 1 }}><Popup className="font-mono text-xs"><strong>{dev.id}</strong><br/>Environment Asset</Popup></CircleMarker>
              )}
              {dev.isPolygon && dev.polygon && dev.type !== 'Environment' && (
                <LeafletPolygon positions={dev.polygon} pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.3, weight: 3 }}><Popup className="font-mono text-xs"><strong>{dev.id}</strong><br/>PIDS Perimeter</Popup></LeafletPolygon>
              )}
              {!dev.isPolygon && dev.type.toUpperCase() === 'CAMERA' && (
                <LeafletPolygon positions={getCameraFovPolygon(dev.lat, dev.lng, dev.outerRange, dev.azimuth, dev.fov)} pathOptions={{ color: '#eab308', fillColor: '#eab308', fillOpacity: 0.2, weight: 1 }} />
              )}
              {!dev.isPolygon && dev.type.toUpperCase() === 'RADAR' && (
                <><Circle center={[dev.lat, dev.lng]} radius={dev.outerRange} pathOptions={{ color: '#ef4444', fillOpacity: 0.05, weight: 1, dashArray: "5, 5" }} /><Circle center={[dev.lat, dev.lng]} radius={dev.innerRange} pathOptions={{ color: '#ef4444', fillOpacity: 0.0, weight: 2 }} /></>
              )}
              {!dev.isPolygon && dev.type !== 'Environment' && (
                <CircleMarker center={[dev.lat, dev.lng]} radius={5} pathOptions={{ color: '#0f172a', fillColor: dev.type.toUpperCase() === 'RADAR' ? '#ef4444' : '#eab308', fillOpacity: 1, weight: 2 }}><Popup className="font-mono text-xs"><strong className="block text-sm mb-1">{dev.id}</strong>Type: {dev.type}</Popup></CircleMarker>
              )}
            </React.Fragment>
          ))}
          {alerts && alerts.map((alert, idx) => {
             const type = alert.sensor_type.toUpperCase();
             const pinColor = type === 'RADAR' ? '#dc2626' : type === 'CAMERA' ? '#facc15' : '#22c55e';
             return (<CircleMarker key={`alert-${idx}`} center={[alert.latitude, alert.longitude]} radius={6} pathOptions={{ color: '#ffffff', fillColor: pinColor, fillOpacity: 1, weight: 1 }}><Popup className="font-mono text-xs"><strong className="block text-sm mb-1">{alert.sensor_type} ALERT</strong>Track ID: {alert.alert_id}</Popup></CircleMarker>);
          })}
        </MapContainer>
      </div>
    </div>
  );
};

// ==========================================
// MODULE 5: REPORTS / EXPORT
// ==========================================
const ExportView = ({ completedRuns }) => {
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async (run) => {
    setIsGenerating(true);
    try {
      const response = await fetch('http://127.0.0.1:8000/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioName: run.scenarioName, devices: run.devices, alerts: run.alerts }) });
      const data = await response.json();
      const kmlBlob = new Blob([data.kml_content], { type: 'application/vnd.google-earth.kml+xml' });
      const link1 = document.createElement('a'); link1.href = URL.createObjectURL(kmlBlob); link1.download = `${run.scenarioName}_Output.kml`; link1.click();
      const csvBlob = new Blob([data.csv_content], { type: 'text/csv' });
      const link2 = document.createElement('a'); link2.href = URL.createObjectURL(csvBlob); link2.download = `${run.scenarioName}_Output.csv`; link2.click();
    } catch (err) { alert("Failed to generate export files from backend."); }
    setIsGenerating(false);
  };

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4"><div><h2 className="text-2xl font-bold text-emerald-400 flex items-center space-x-2"><FileOutput className="w-6 h-6" /> <span>Reports & Export</span></h2></div></div>
      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden shadow-sm">
        <div className="bg-slate-850 border-b border-slate-800 px-5 py-4"><h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center"><CheckCircle className="w-4 h-4 mr-2 text-cyan-400"/> Completed Simulation Runs ({completedRuns.length})</h3></div>
        <div className="p-0 max-h-[500px] overflow-y-auto">
          {completedRuns.length === 0 ? <div className="p-10 text-center text-slate-500 font-mono text-sm">No simulations have been completed yet.</div> : (
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-950/50 text-slate-400 font-mono text-xs sticky top-0"><tr><th className="p-4">Timestamp</th><th className="p-4">Designation</th><th className="p-4">Alerts Transmitted</th><th className="p-4 text-right">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-800/50">
                {completedRuns.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-800/30">
                    <td className="p-4 text-slate-300 font-mono text-xs">{run.timestamp}</td><td className="p-4 font-bold text-emerald-400">{run.scenarioName}</td><td className="p-4 text-slate-300 font-mono">{run.alertsGenerated} Packets</td>
                    <td className="p-4 text-right">
                        <button onClick={() => handleGenerate(run)} disabled={isGenerating} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold px-4 py-2 rounded transition-colors text-xs flex items-center ml-auto">
                            <Download className="w-3 h-3 mr-2" /> {isGenerating ? "GENERATING..." : "GENERATE OUTPUT KML/CSV"}
                        </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

// ==========================================
// MASTER APP
// ==========================================
export default function App() {
  const [currentView, setCurrentView] = useState('Device Configuration');
  const [dbStatus, setDbStatus] = useState('Checking...');
  const [sensorSchemas, setSensorSchemas] = useState([]); 
  const [devices, setDevices] = useState([]);
  const [scenario, setScenario] = useState({ name: 'Operation Alpha', activeDevices: [], udpIp: '127.0.0.1', udpPort: 5005 });
  const [alertConfig, setAlertConfig] = useState({ minDelaySec: 0.1, maxDelaySec: 0.5 });
  const [completedRuns, setCompletedRuns] = useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);
  
  const [simIsRunning, setSimIsRunning] = useState(false);
  const [simLogs, setSimLogs] = useState([]);
  const [simProgress, setSimProgress] = useState(0);
  const [overrideCounts, setOverrideCounts] = useState({});
  const engineRef = useRef({ isRunning: false, currentAlert: 0, targetTotalAlerts: 0, executionPool: [], generatedAlertsMemory: [], timeout: null });

  const getAlertCount = (dev) => overrideCounts[dev.id] !== undefined ? overrideCounts[dev.id] : (dev.alertCount || 0);

  // LOG PERSISTENCE HELPER: Writes to React Array AND Database simultaneously
  const addLog = (msg, type) => {
    const timeStr = new Date().toLocaleTimeString();
    const newLog = { time: timeStr, msg, type };
    setSimLogs(prev => [newLog, ...prev]);
    fetch('http://127.0.0.1:8000/api/state/logs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newLog)
    }).catch(()=>{});
  };

  const fetchHistory = () => {
    fetch('http://127.0.0.1:8000/api/runs')
      .then(res => res.json()).then(data => { if(Array.isArray(data)) setCompletedRuns(data); })
      .catch(e => console.error("History fetch failed"));
  };

  useEffect(() => {
    fetch('http://127.0.0.1:8000/api/config/schemas')
      .then(res => { if (res.ok) { setDbStatus('CONNECTED'); return res.json(); } throw new Error(); })
      .then(data => { if(Array.isArray(data)) setSensorSchemas(data); })
      .catch(e => setDbStatus('DISCONNECTED'));

    fetch('http://127.0.0.1:8000/api/config/devices')
      .then(res => res.json()).then(data => { if(Array.isArray(data)) setDevices(data); }).catch(e => console.error(e));
      
    fetch('http://127.0.0.1:8000/api/state/scenario')
      .then(res => res.json()).then(data => { if(data && data.name) setScenario(data); }).catch(e => console.error(e));
      
    fetch('http://127.0.0.1:8000/api/state/alerts')
      .then(res => res.json()).then(data => { if(Array.isArray(data)) setActiveAlerts(data); }).catch(e => console.error(e));
      
    // FETCH TELEMETRY LOGS ON LOAD
    fetch('http://127.0.0.1:8000/api/state/logs')
      .then(res => res.json()).then(data => { if(Array.isArray(data)) setSimLogs(data); }).catch(e => console.error(e));

    fetchHistory();
  }, []);

  const startSimulation = () => {
    const activeFleet = devices.filter(d => scenario.activeDevices.includes(d.id));
    const environmentFleet = devices.filter(d => d.type === 'Environment');
    const targetTotalAlerts = activeFleet.reduce((acc, dev) => acc + getAlertCount(dev), 0);

    if (activeFleet.length === 0) return alert("MISSION ABORT: No active sensors bound.");
    if (targetTotalAlerts <= 0) return alert("MISSION ABORT: Target payload is 0.");

    fetch('http://127.0.0.1:8000/api/state/alerts', { method: 'DELETE' }).catch(console.error);
    fetch('http://127.0.0.1:8000/api/state/logs', { method: 'DELETE' }).catch(console.error); 

    let pool = [];
    activeFleet.forEach(dev => { 
        const count = getAlertCount(dev);
        for(let i = 0; i < count; i++) { pool.push(dev); } 
    });
    pool = pool.sort(() => Math.random() - 0.5);

    engineRef.current = { isRunning: true, currentAlert: 0, targetTotalAlerts, executionPool: pool, generatedAlertsMemory: [], timeout: null };
    setSimIsRunning(true);
    setSimProgress(0);
    setActiveAlerts([]);
    setSimLogs([]); 
    
    addLog(`SYSTEM: Engaging '${scenario.name}'. UDP Engine Active.`, 'info');

    const runTick = async () => {
      if (!engineRef.current.isRunning) return;

      if (engineRef.current.currentAlert >= engineRef.current.targetTotalAlerts) {
        setSimIsRunning(false);
        engineRef.current.isRunning = false;
        addLog(`SYSTEM: Transmission Complete. ${engineRef.current.targetTotalAlerts} packets sent.`, 'info');
        
        try {
          addLog(`DATABASE: Committing payload...`, 'info');
          const response = await fetch('http://127.0.0.1:8000/api/database/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenarioName: scenario.name, alerts: engineRef.current.generatedAlertsMemory, devices: activeFleet.concat(environmentFleet) })
          });
          const data = await response.json();
          if (data.status === "success") {
              addLog(`DATABASE: ${data.message}`, 'success');
              fetchHistory(); 
          }
        } catch (e) { addLog(`DB ERROR: Postgres unreachable.`, 'error'); }
        return;
      }

      const dev = engineRef.current.executionPool[engineRef.current.currentAlert]; 
      engineRef.current.currentAlert++;
      const selectedSchema = sensorSchemas.find(s => s.name.toUpperCase() === (dev.packetChoice || "").toUpperCase()) || null;

      try {
        const response = await fetch('http://127.0.0.1:8000/api/transmit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetIp: scenario.udpIp, targetPort: scenario.udpPort, trackId: engineRef.current.currentAlert, device: dev, customSchema: selectedSchema ? selectedSchema.schema : null, customSeparator: selectedSchema ? selectedSchema.separator : "," })
        });
        const result = await response.json();
        if (result.status === "success" && engineRef.current.isRunning) {
            engineRef.current.generatedAlertsMemory.push(result.alert_data);
            setActiveAlerts(prev => [...prev, result.alert_data]);
            
            fetch('http://127.0.0.1:8000/api/state/alerts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.alert_data)
            }).catch(()=>{});

            addLog(`[${dev.id}] -> ${result.packet}`, 'success');
        } else { addLog(`[ERROR] Python: ${result.message}`, 'error'); }
      } catch (error) { if (engineRef.current.isRunning) addLog(`[ERROR] Engine Refused.`, 'error'); }

      if (engineRef.current.isRunning) {
          setSimProgress(Math.floor((engineRef.current.currentAlert / engineRef.current.targetTotalAlerts) * 100));
          const delay = Math.random() * (alertConfig.maxDelaySec - alertConfig.minDelaySec) + alertConfig.minDelaySec;
          engineRef.current.timeout = setTimeout(runTick, delay * 1000);
      }
    };
    runTick();
  };

  const stopSimulation = () => {
    clearTimeout(engineRef.current.timeout); 
    engineRef.current.isRunning = false;
    setSimIsRunning(false);
    addLog('SYSTEM: Transmission Aborted.', 'error');
  };

  const menuItems = [
    { name: 'Device Configuration', icon: Settings },
    { name: 'Scenario Builder', icon: Sliders },
    { name: 'Tactical Map', icon: Globe },
    { name: 'Alert Generator', icon: BellDot },
    { name: 'Reports / Export', icon: FileOutput },
  ];

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans selection:bg-cyan-900 overflow-hidden">
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 z-10 shadow-2xl">
        <div className="h-16 border-b border-slate-800 flex items-center px-6"><Shield className="w-6 h-6 text-emerald-400 mr-3" /><span className="font-bold tracking-wider text-lg">SIMCORE <span className="text-xs text-slate-500">v2.5</span></span></div>
        <nav className="flex-1 py-4 overflow-y-auto">
          <ul className="space-y-1">
            {menuItems.map((item) => {
              const Icon = item.icon; const isActive = currentView === item.name;
              return (<li key={item.name}><button onClick={() => setCurrentView(item.name)} className={`w-full flex items-center px-6 py-3 text-sm font-medium transition-colors ${isActive ? 'bg-emerald-950/30 text-emerald-400 border-r-2 border-emerald-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}><Icon className={`w-4 h-4 mr-3 ${isActive ? 'text-emerald-400' : 'opacity-70'}`} /> {item.name}</button></li>);
            })}
          </ul>
        </nav>
      </aside>
      <main className="flex-1 flex flex-col relative overflow-hidden bg-slate-950">
        <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur px-6 flex items-center justify-between shrink-0">
          <h1 className="text-sm font-bold text-slate-300 uppercase tracking-widest">{currentView}</h1>
          <div className="flex items-center space-x-4">
            <div className={`flex items-center space-x-2 px-3 py-1.5 rounded-md border font-mono text-xs ${dbStatus === 'CONNECTED' ? 'bg-emerald-950 border-emerald-800 text-emerald-400' : 'bg-rose-950 border-rose-800 text-rose-400'}`}>
                <span className={`w-2 h-2 rounded-full ${dbStatus === 'CONNECTED' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                <span>DB: {dbStatus}</span>
            </div>
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-md bg-slate-950 border border-slate-800 font-mono text-xs"><span className={`w-2 h-2 rounded-full ${simIsRunning ? 'bg-rose-500 animate-pulse' : 'bg-amber-500'}`}></span><span className="text-slate-300">ENGINE: {simIsRunning ? 'TRANSMITTING' : 'IDLE'}</span></div>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {currentView === 'Device Configuration' && <DeviceConfigView devices={devices} setDevices={setDevices} sensorSchemas={sensorSchemas} setSensorSchemas={setSensorSchemas} />}
          {currentView === 'Scenario Builder' && <ScenarioBuilderView devices={devices} scenario={scenario} setScenario={setScenario} />}
          {currentView === 'Tactical Map' && <MapView devices={devices} alerts={activeAlerts} />}
          {currentView === 'Alert Generator' && <AlertGeneratorView devices={devices} scenario={scenario} alertConfig={alertConfig} setAlertConfig={setAlertConfig} setCompletedRuns={setCompletedRuns} setActiveAlerts={setActiveAlerts} sensorSchemas={sensorSchemas} simIsRunning={simIsRunning} simLogs={simLogs} simProgress={simProgress} startSimulation={startSimulation} stopSimulation={stopSimulation} overrideCounts={overrideCounts} setOverrideCounts={setOverrideCounts} getAlertCount={getAlertCount} />}
          {currentView === 'Reports / Export' && <ExportView completedRuns={completedRuns} />}
        </div>
      </main>
    </div>
  );
}