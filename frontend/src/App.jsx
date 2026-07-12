import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Shield, Settings, Server, MapPin, Trash2, CheckCircle, 
  Upload, Network, Clock, FileOutput, Save, BellDot, 
  Globe, Sliders, Play, Square, Terminal, CheckSquare, Download, Target,
  AlertTriangle, Search, ArrowUpDown, Calendar, Layers, FolderTree,
  Menu, Maximize, Minimize, X, Briefcase
} from 'lucide-react';
import { MapContainer, TileLayer, Popup, CircleMarker, Circle, Polygon as LeafletPolygon, Polyline as LeafletPolyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import TelemetryProgress from './components/TelemetryProgress';
import { MultiFileKMLParser } from './utils/kmlparser';

const kmlParser = new MultiFileKMLParser();

// ==========================================
// GEOMETRY ENGINE 
// ==========================================
const getCameraFovPolygon = (lat, lng, radiusMeters = 100, azimuth = 0, fov = 360) => {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return [];
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
  return points.length > 0 ? points : [];
};

const parseKmlColor = (kmlHex) => {
  if (!kmlHex || String(kmlHex).length !== 8) return null;
  const hexStr = String(kmlHex);
  const rr = hexStr.substring(6, 8);
  const gg = hexStr.substring(4, 6);
  const bb = hexStr.substring(2, 4);
  return `#${rr}${gg}${bb}`;
};

// ==========================================
// MODULE 1: DEVICE CONFIGURATION
// ==========================================
const DeviceConfigView = ({ devices, setDevices, sensorSchemas, setSensorSchemas, allWorkspaces, setCustomWorkspaces, activeWorkspace, setActiveWorkspace, handleSensorEventsUpload }) => {
  const [status, setStatus] = useState({ message: 'System Ready', type: 'info' });
  const [newWorkspaceName, setNewWorkspaceName] = useState('');

  const safeDevices = Array.isArray(devices) ? devices : [];

  useEffect(() => {
    if (allWorkspaces.length > 0 && !allWorkspaces.includes(activeWorkspace)) {
      setActiveWorkspace(allWorkspaces[0]);
    }
  }, [allWorkspaces, activeWorkspace]);

  const hardwareSensors = useMemo(() => safeDevices.filter(d => d && d.type && !String(d.type).toUpperCase().includes('ENV') && (d.workspace || 'Default') === activeWorkspace), [safeDevices, activeWorkspace]);
  const environmentFeatures = useMemo(() => safeDevices.filter(d => d && d.type && String(d.type).toUpperCase().includes('ENV') && (d.workspace || 'Default') === activeWorkspace), [safeDevices, activeWorkspace]);

  const fileGroups = useMemo(() => {
    const map = new Map();
    environmentFeatures.forEach(env => {
        const key = `${env.workspace || 'Default'}::${env.sourceFile || 'Uploaded KML'}`;
        if(!map.has(key)) {
            map.set(key, { 
                workspace: env.workspace || 'Default', 
                sourceFile: env.sourceFile || 'Uploaded KML', 
                color: env.color, 
                envCategory: env.envCategory, 
                count: 1,
                ids: [env.id]
            });
        } else {
            const obj = map.get(key);
            obj.count += 1;
            obj.ids.push(env.id);
        }
    });
    return Array.from(map.values());
  }, [environmentFeatures]);

  const syncDevicesToDB = async () => {
    try {
      const response = await fetch('/api/config/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(safeDevices)
      });
      if (response.ok) {
        alert("✅ SUCCESS: All Sensors & GIS features saved to PostgreSQL!");
        setStatus({ message: "All Entities Saved to DB", type: "success" });
      } else {
        const text = await response.text();
        alert("❌ PYTHON REJECTED THE DATA:\n" + text);
      }
    } catch (err) { alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message); }
  };

  const syncSchemasToDB = async () => {
    try {
      const response = await fetch('/api/config/schemas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Array.isArray(sensorSchemas) ? sensorSchemas : [])
      });
      if (response.ok) {
        alert("✅ SUCCESS: Packet Formats saved to PostgreSQL!");
        setStatus({ message: "Formats Saved to DB", type: "success" });
      } else {
        const text = await response.text();
        alert("❌ PYTHON REJECTED THE DATA:\n" + text);
      }
    } catch (err) { alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message); }
  };

  const handleCreateWorkspace = () => {
    if(newWorkspaceName.trim()) {
        const wsName = newWorkspaceName.trim();
        setCustomWorkspaces(prev => [...prev, wsName]);
        setActiveWorkspace(wsName);
    }
    setNewWorkspaceName('');
  };

  const handleSensorJsonUpload = async (event) => {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    let combinedSensors = [];
    for (const file of files) {
        try {
            let text = await file.text();
            text = text.replace(/(:\s*)(Point\s*\([^)]+\))/gi, '$1"$2"');
            text = text.replace(/(:\s*)(Polygon\s*\(\([\s\S]*?\)\))/gi, '$1"$2"');
            text = text.replace(/,\s*([}\]])/g, '$1'); 

            const data = JSON.parse(text);
            const dataArray = Array.isArray(data) ? data : [data];

            const isValidFormat = dataArray.every(d => d.SensorId && d.SensorType && d.geometry);
            if (!isValidFormat) throw new Error(`Missing required fields. Each object must have a SensorId, SensorType, and geometry.`);

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
                    alertCount: parseInt(d.AlertCount || 0), packetChoice: d.PacketChoice || "", lat, lng, isPolygon, polygon: polygonArr,
                    workspace: activeWorkspace 
                };
            });
            combinedSensors = [...combinedSensors, ...parsedSensors];
        } catch (err) { alert(`🚨 FORMAT ERROR in ${file.name}!\n\nDetails: ${err.message}`); }
    }
    setDevices(prev => [...(Array.isArray(prev) ? prev : []), ...combinedSensors]);
    setStatus({ message: `Loaded ${combinedSensors.length} Sensors into ${activeWorkspace}.`, type: 'info' });
  };

  const handleSchemaUpload = async (event) => {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    let combinedSchemas = [];
    for (const file of files) {
        try {
            const text = await file.text();
            const parsedData = JSON.parse(text);
            const dataArray = Array.isArray(parsedData) ? parsedData : [parsedData];
            const isValid = dataArray.every(item => item.protocolName && Array.isArray(item.fields));
            if (!isValid) throw new Error("Missing 'protocolName' or 'fields' array.");

            const schemasToAdd = dataArray.map(item => ({
                name: item.protocolName.toUpperCase(),
                separator: item.separator || ',',
                totalIndexes: item.fields.length,
                schema: item.fields
            }));
            combinedSchemas = [...combinedSchemas, ...schemasToAdd];
        } catch (err) { alert(`🚨 SCHEMA ERROR in ${file.name}!\n\nDetails: ${err.message}`); }
    }
    setSensorSchemas(prev => [...(Array.isArray(prev) ? prev : []), ...combinedSchemas]);
    setStatus({ message: `Loaded ${combinedSchemas.length} Protocol Schemas.`, type: 'info' });
  };

  const handleEnvironmentKmlUpload = async (event) => {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    let combinedEnvs = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            const text = await file.text();
            const isolatedLayer = kmlParser.parseAndIsolate(file.name, text, i);
            const fname = file.name.toUpperCase();
            
            let envCategory = "GENERAL";
            if (fname.includes("BUILDING")) envCategory = "BUILDING";
            else if (fname.includes("ROAD")) envCategory = "ROAD";
            else if (fname.includes("RAIL")) envCategory = "RAILWAY";
            else if (fname.includes("VEGETATION")) envCategory = "VEGETATION";
            else if (fname.includes("WATER")) envCategory = "WATERBODY";
            else if (fname.includes("PERIMETER")) envCategory = "PERIMETER";

            isolatedLayer.features.forEach((feat, idx) => {
                const leafletCoords = feat.coordinates.map(coord => [coord[1], coord[0]]);
                const uniqueId = `${activeWorkspace}_${file.name}_${feat.name}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
                
                combinedEnvs.push({
                    id: uniqueId, 
                    type: "Environment", 
                    envCategory, 
                    sourceFile: file.name,
                    isPolygon: feat.geometryType === 'Polygon' || feat.geometryType === 'LineString', 
                    polygon: leafletCoords,
                    lat: leafletCoords[0]?.[0] || 0, 
                    lng: leafletCoords[0]?.[1] || 0,
                    innerRange: 0, outerRange: 0, azimuth: 0, fov: 0, alertCount: 0, packetChoice: "",
                    color: feat.style.fillColor,
                    workspace: activeWorkspace 
                });
            });
        } catch (err) { alert(`🚨 KML SYNTAX ERROR in ${file.name}!`); }
    }
    setDevices(prev => [...(Array.isArray(prev) ? prev : []), ...combinedEnvs]);
    setStatus({ message: `Loaded ${combinedEnvs.length} GIS Features via MultiFileKMLParser. Click 'Save GIS to DB'.`, type: 'info' });
  };

  const removeDevice = (id) => {
    setDevices(safeDevices.filter(d => d.id !== id));
    fetch(`/api/config/devices/${id}`, { method: 'DELETE' }).catch(() => {});
  };

  const removeFileFeatures = async (ids) => {
    if (!window.confirm(`Are you sure you want to delete these ${ids.length} GIS features permanently?`)) return;
    setDevices(prev => prev.filter(d => !ids.includes(d.id)));
    try {
        await fetch('/api/config/devices/delete_batch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
        });
    } catch (err) {}
  };

  const removeSchema = (name) => {
    setSensorSchemas((Array.isArray(sensorSchemas) ? sensorSchemas : []).filter(s => s.name !== name));
    fetch(`/api/config/schemas/${name}`, { method: 'DELETE' }).catch(() => {});
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div><h2 className="text-2xl font-bold text-emerald-400 flex items-center space-x-2"><Settings className="w-6 h-6" /> <span>Device Configuration</span></h2></div>
        <div className={`px-4 py-2 rounded font-mono text-xs font-bold border ${status.type === 'error' ? 'bg-rose-950/50 border-rose-800 text-rose-400' : 'bg-emerald-950/50 border-emerald-800 text-emerald-400'}`}>{status.message}</div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex items-center space-x-4">
              <Briefcase className="w-6 h-6 text-emerald-400" />
              <div className="flex flex-col">
                  <span className="text-xs font-mono text-slate-500 uppercase">Target Workspace Environment</span>
                  <select value={activeWorkspace} onChange={e => setActiveWorkspace(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-sm font-bold text-emerald-400 focus:outline-none focus:border-emerald-500 mt-1 min-w-[200px] cursor-pointer">
                      {allWorkspaces.length === 0 && <option value="Default">Default</option>}
                      {allWorkspaces.map(ws => <option key={ws} value={ws}>{ws}</option>)}
                  </select>
              </div>
          </div>
          <div className="flex items-center space-x-2 bg-slate-950 p-2 rounded border border-slate-800">
              <input type="text" value={newWorkspaceName} onChange={e => setNewWorkspaceName(e.target.value)} placeholder="New Workspace Name..." className="bg-transparent px-2 py-1 text-sm text-slate-200 outline-none w-48" />
              <button onClick={handleCreateWorkspace} className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-1.5 px-4 rounded text-xs transition-colors cursor-pointer">CREATE & SELECT</button>
          </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm flex flex-col relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-fuchsia-500"></div>
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center"><Settings className="w-4 h-4 mr-2 text-fuchsia-400"/> Global Packet Formats</h3>
          <p className="text-[10px] font-mono text-slate-500 mb-4 truncate">Applies globally across all workspaces</p>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative flex-1 flex flex-col justify-center">
            <input type="file" multiple accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSchemaUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Server className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload JSON Schema(s)</p>
          </div>
        </div>
        {/* --- START OF THE CODE YOU JUST PASTED --- */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm flex flex-col relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-fuchsia-500"></div>
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center"><Terminal className="w-4 h-4 mr-2 text-fuchsia-400"/> Global Sensor Events</h3>
          <p className="text-[10px] font-mono text-slate-500 mb-4 truncate">Applies globally across all workspaces</p>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative flex-1 flex flex-col justify-center">
            <input type="file" accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSensorEventsUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Server className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload Events (.JSON)</p>
          </div>
        </div>
        {/* --- END OF THE CODE YOU JUST PASTED --- */}

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm flex flex-col relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500"></div>
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center"><Target className="w-4 h-4 mr-2 text-rose-400"/> Sensor Array Input</h3>
          <p className="text-[10px] font-mono text-emerald-500 mb-4 truncate">Targeting Workspace: <span className="font-bold">{activeWorkspace}</span></p>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative flex-1 flex flex-col justify-center">
            <input type="file" multiple accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSensorJsonUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Target className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload Sensor Array (.JSON)</p>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm flex flex-col relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500"></div>
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center"><MapPin className="w-4 h-4 mr-2 text-cyan-400"/> Environment Input</h3>
          <p className="text-[10px] font-mono text-emerald-500 mb-4 truncate">Targeting Workspace: <span className="font-bold">{activeWorkspace}</span></p>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative flex-1 flex flex-col justify-center">
            <input type="file" multiple accept=".kml" onClick={(e) => { e.target.value = null; }} onChange={handleEnvironmentKmlUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <MapPin className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">Upload Environment (.KML)</p>
          </div>
        </div>

      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-6">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-lg flex flex-col overflow-hidden shadow-sm h-[380px]">
          <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center"><Server className="w-4 h-4 mr-2 text-indigo-400"/> Deployed Sensors ({hardwareSensors.length})</h3>
            <button onClick={syncDevicesToDB} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg cursor-pointer"><Save className="w-4 h-4 mr-2" /> SAVE SENSORS TO DB</button>
          </div>
          <div className="flex-1 overflow-auto p-0">
            {hardwareSensors.length === 0 ? <div className="h-full flex flex-col items-center justify-center text-slate-600 font-mono text-sm">No hardware sensors loaded in this workspace.</div> : (
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-950/50 text-slate-400 font-mono text-xs sticky top-0 z-10"><tr><th className="p-3">ID / Protocol</th><th className="p-3">Location / Boundary</th><th className="p-3">Parameters</th><th className="p-3 text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-800/50">
                  {hardwareSensors.map((dev, idx) => {
                    const devName = dev?.packetChoice || '';
                    const isMissingPacket = devName && !(Array.isArray(sensorSchemas) ? sensorSchemas : []).some(s => s && s.name && s.name.toUpperCase() === devName.toUpperCase());
                    return (
                      <tr key={dev.id || idx} className="hover:bg-slate-800/30">
                        <td className="p-3">
                            <div className="font-bold text-slate-200">{dev.id || "Unknown"}</div>
                            <div className={`text-xs uppercase flex items-center ${isMissingPacket ? 'text-rose-400 font-bold' : 'text-cyan-500'}`}>
                                {dev.packetChoice ? `PKT: ${dev.packetChoice}` : (dev.type || 'UNKNOWN')}
                                {isMissingPacket && <AlertTriangle className="w-3 h-3 ml-1" title="Missing Packet Format Schema!" />}
                            </div>
                        </td>
                        <td className="p-3 font-mono text-xs text-slate-400">{dev.isPolygon ? `PIDS FENCE (${Array.isArray(dev.polygon) ? dev.polygon.length : 0} pts)` : `${parseFloat(dev.lat || 0).toFixed(4)}, ${parseFloat(dev.lng || 0).toFixed(4)}`}</td>
                        <td className="p-3 font-mono text-cyan-400 text-xs">{dev.isPolygon ? `${dev.alertCount || 0} Target Alerts` : `${dev.innerRange || 0}-${dev.outerRange || 0}m | ${dev.alertCount || 0} Alerts`}</td>
                        <td className="p-3 text-right"><button onClick={() => removeDevice(dev.id)} className="text-slate-500 hover:text-rose-400 cursor-pointer"><Trash2 className="w-4 h-4 inline" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg flex flex-col overflow-hidden shadow-sm h-[380px]">
          <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center"><Settings className="w-4 h-4 mr-2 text-fuchsia-400"/> Packet Formats ({(Array.isArray(sensorSchemas) ? sensorSchemas : []).length})</h3>
            <button onClick={syncSchemasToDB} className="bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg cursor-pointer"><Save className="w-4 h-4 mr-2" /> SAVE FORMATS</button>
          </div>
          <div className="flex-1 overflow-auto">
            {(!sensorSchemas || sensorSchemas.length === 0) ? <div className="p-10 text-center text-slate-500 font-mono text-xs">No schemas loaded.</div> : (
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="bg-slate-950/50 text-slate-400 font-mono sticky top-0"><tr><th className="p-3">Protocol Match</th><th className="p-3 text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-800/50">
                  {sensorSchemas.map((schema, idx) => (
                    <tr key={schema.name || idx} className="hover:bg-slate-800/30">
                      <td className="p-3 font-bold text-fuchsia-400">{schema.name || 'UNKNOWN'} <span className="text-slate-500 font-normal">[{schema.separator || ','}]</span></td>
                      <td className="p-3 text-right"><button onClick={() => removeSchema(schema.name)} className="text-slate-500 hover:text-rose-400 cursor-pointer"><Trash2 className="w-4 h-4 inline" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg flex flex-col overflow-hidden shadow-sm h-[360px] mt-6">
        <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex justify-between items-center">
          <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center">
            <Layers className="w-4 h-4 mr-2 text-emerald-400"/> Workspace KML Files ({fileGroups.length})
          </h3>
          <div className="flex items-center space-x-3">
            <button onClick={syncDevicesToDB} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg cursor-pointer">
              <Save className="w-4 h-4 mr-2" /> SAVE GIS TO DB
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-0">
          {fileGroups.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 font-mono text-sm">
              No KML Environment layers loaded in this workspace. 
            </div>
          ) : (
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-950/50 text-slate-400 font-mono text-xs sticky top-0 z-10">
                <tr>
                  <th className="p-3">Uploaded KML File</th>
                  <th className="p-3">Category Assignment</th>
                  <th className="p-3">Feature Complexity</th>
                  <th className="p-3">Assigned Layer Color</th>
                  <th className="p-3 text-right">Delete Layer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {fileGroups.map((group, idx) => (
                  <tr key={idx} className="hover:bg-slate-800/30">
                    <td className="p-3">
                      <div className="font-bold text-emerald-400">{group.sourceFile}</div>
                      <div className="text-[11px] font-mono text-slate-500">Workspace: {group.workspace}</div>
                    </td>
                    <td className="p-3 font-mono text-xs text-slate-300 uppercase">
                      {group.envCategory}
                    </td>
                    <td className="p-3 font-mono text-xs text-amber-400">
                      Contains {group.count} discrete features
                    </td>
                    <td className="p-3 font-mono text-xs flex items-center space-x-2">
                      <span className="w-3.5 h-3.5 rounded-full border border-slate-500 shadow-sm inline-block" style={{ backgroundColor: group.color }}></span>
                      <span className="text-slate-300 font-bold">{group.color}</span>
                    </td>
                    <td className="p-3 text-right">
                      <button onClick={() => removeFileFeatures(group.ids)} className="text-slate-500 hover:text-rose-400 cursor-pointer">
                        <Trash2 className="w-4 h-4 inline" />
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
// MODULE 2: SCENARIO BUILDER
// ==========================================
const ScenarioBuilderView = ({ scenario, setScenario, devices, sensorSchemas, activeWorkspace, sensorEvents }) => {
  const [status, setStatus] = useState('');
  
  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeSchemas = Array.isArray(sensorSchemas) ? sensorSchemas : [];
  const safeActiveDevices = Array.isArray(scenario?.activeDevices) ? scenario.activeDevices : [];
  
  const allWorkspaces = useMemo(() => Array.from(new Set(safeDevices.map(d => d.workspace || 'Default'))), [safeDevices]);

  const configurableSensors = useMemo(() => safeDevices.filter(d => {
      if (!d || !d.type || String(d.type).toUpperCase().includes('ENV')) return false;
      if ((d.workspace || 'Default') !== activeWorkspace) return false;
      const hasPacketChoice = !!d.packetChoice;
      const isMissingPacket = hasPacketChoice && !safeSchemas.some(s => s && s.name && String(s.name).toUpperCase() === String(d.packetChoice).toUpperCase());
      return !isMissingPacket; 
  }), [safeDevices, safeSchemas, activeWorkspace]);

  const allSensorIds = useMemo(() => configurableSensors.map(d => d.id).filter(Boolean), [configurableSensors]);
  const isAllSelected = allSensorIds.length > 0 && allSensorIds.every(id => safeActiveDevices.includes(id));
  
  const envFiles = useMemo(() => {
    const files = new Set();
    safeDevices.forEach(d => {
       if (d.type === 'Environment' && (d.workspace || 'Default') === activeWorkspace && d.sourceFile) {
           files.add(d.sourceFile);
       }
    });
    return Array.from(files);
  }, [safeDevices, activeWorkspace]);

  const handleSelectAll = () => {
    if (isAllSelected) {
        setScenario(prev => ({ ...prev, activeDevices: (prev.activeDevices || []).filter(id => !allSensorIds.includes(id)) }));
    } else {
        setScenario(prev => ({ ...prev, activeDevices: [...new Set([...(prev.activeDevices || []), ...allSensorIds])] }));
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setScenario(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };
  
  const toggleDevice = (id) => {
    setScenario(prev => {
      const activeList = Array.isArray(prev.activeDevices) ? prev.activeDevices : [];
      const isActive = activeList.includes(id);
      return { ...prev, activeDevices: isActive ? activeList.filter(d => d !== id) : [...activeList, id] };
    });
  };

  const handleProbChange = (fileName, value) => {
    setScenario(prev => ({
        ...prev,
        kmlProbabilities: {
            ...(prev.kmlProbabilities || {}),
            [fileName]: value !== '' ? parseFloat(value) : undefined
        }
    }));
  };

  // --- NEW: Map Device ID to a selected TargetType ID ---
  const handleTargetChange = (deviceId, targetId) => {
    setScenario(prev => ({
        ...prev,
        deviceAlertMapping: {
            ...(prev.deviceAlertMapping || {}),
            [deviceId]: targetId ? parseInt(targetId, 10) : null
        }
    }));
  };

  // Resolve which event list to show based on device type
  const getEventsForDevice = (type) => {
    const t = String(type).toUpperCase();
    if (t.includes('RADAR')) return sensorEvents?.RADAR || [];
    if (t.includes('CAM')) return sensorEvents?.CAMERA || [];
    if (t.includes('PIDS')) return sensorEvents?.PIDS || [];
    return [];
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if(!scenario || !Array.isArray(scenario.activeDevices) || scenario.activeDevices.length === 0) return alert("You must select at least one active sensor!");
    
    const payloadToSave = { ...scenario, workspace: activeWorkspace };

    try {
        const response = await fetch('/api/state/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadToSave) });
        if (response.ok) {
            setStatus('Scenario compiled and State Saved to Database.');
            setTimeout(() => setStatus(''), 4000);
        }
    } catch (err) { alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message); }
  };

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
            <h2 className="text-2xl font-bold text-indigo-400 flex items-center space-x-2">
                <Sliders className="w-6 h-6" /> 
                <span>Scenario Builder <span className="text-sm font-mono text-slate-500 ml-2">[{activeWorkspace}]</span></span>
            </h2>
        </div>
        <span className="text-emerald-400 text-sm font-mono font-bold">{status && <><CheckCircle className="w-4 h-4 inline mr-2" />{status}</>}</span>
      </div>
      <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm md:col-span-2">
          <div>
            <label className="block text-xs font-mono text-slate-500 mb-1 uppercase tracking-wider">Mission Designation</label>
            <input type="text" name="name" required value={scenario?.name || ''} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-4 py-3 text-white text-lg font-bold focus:border-indigo-500 focus:outline-none" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm md:col-span-2">
          <div className="flex justify-between items-center border-b border-slate-800 pb-2 mb-4">
              <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center">
                  <MapPin className="w-4 h-4 mr-2 text-emerald-400"/> GIS Probability Constraints
              </h3>
          </div>
          <div className="space-y-3 max-h-48 overflow-y-auto pr-2">
            {envFiles.length === 0 ? (
              <div className="text-xs font-mono text-slate-500 p-3 bg-slate-950 rounded border border-slate-800">No KML files loaded in this Workspace.</div>
            ) : (
              envFiles.map(file => (
                <div key={file} className="flex items-center justify-between p-3 rounded border border-slate-800 bg-slate-950 hover:border-slate-700 transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-emerald-400 truncate w-48 md:w-auto" title={file}>{file}</span>
                    <span className="text-[10px] font-mono text-slate-500 uppercase">Detection Prob. (0.0 - 1.0)</span>
                  </div>
                  <input 
                    type="number" step="0.01" min="0" max="1" 
                    placeholder="Default"
                    value={scenario?.kmlProbabilities?.[file] !== undefined ? scenario.kmlProbabilities[file] : ''}
                    onChange={(e) => handleProbChange(file, e.target.value)}
                    className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-emerald-400 font-mono text-center text-sm focus:border-emerald-500 focus:outline-none" 
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* --- HARDWARE BINDING & EVENT OVERRIDE UI --- */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
          <div className="flex justify-between items-center border-b border-slate-800 pb-2 mb-4">
              <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center">
                  <CheckSquare className="w-4 h-4 mr-2 text-amber-400"/> Hardware Binding
              </h3>
              {configurableSensors.length > 0 && (
                  <label className="flex items-center space-x-2 text-xs font-mono text-emerald-400 cursor-pointer hover:text-emerald-300">
                      <span>SELECT ALL</span>
                      <input type="checkbox" checked={isAllSelected} onChange={handleSelectAll} className="w-3 h-3 accent-emerald-500 cursor-pointer" />
                  </label>
              )}
          </div>

          <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
            {configurableSensors.length === 0 ? (
              <div className="text-xs font-mono text-rose-400 p-4 bg-rose-950/20 border border-rose-900/50 rounded flex flex-col space-y-2">
                <strong className="text-sm">⚠️ No configurable sensors found.</strong>
                <p>Sensors are hidden from this list if:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>They belong to a different Workspace.</li>
                  <li>They require a Packet Format that is missing from Global Packet Formats.</li>
                </ul>
              </div>
            ) : (
              configurableSensors.map(dev => {
                const isActive = (scenario?.activeDevices || []).includes(dev.id);
                const events = getEventsForDevice(dev.type);
                const selectedTargetId = scenario?.deviceAlertMapping?.[dev.id] || '';

                return (
                <div key={dev.id} className={`flex flex-col p-3 rounded cursor-pointer border transition-colors ${isActive ? 'bg-indigo-950/40 border-indigo-500/50' : 'bg-slate-950 border-slate-800 hover:border-slate-700'}`}>
                  
                  <div className="flex items-center justify-between" onClick={() => toggleDevice(dev.id)}>
                    <div>
                        <span className={`text-sm font-bold ${isActive ? 'text-indigo-400' : 'text-slate-300'}`}>{dev.id}</span>
                        <span className="text-xs text-slate-500 ml-2 uppercase">({dev.type})</span>
                    </div>
                    <input type="checkbox" checked={isActive} readOnly className="w-4 h-4 accent-indigo-500" />
                  </div>

                  {/* Dynamic Target Selection Dropdown (Only visible when activated) */}
                  {isActive && events.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-800/50 flex items-center justify-between" onClick={e => e.stopPropagation()}>
                          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Target Signature</span>
                          <select
                              value={selectedTargetId}
                              onChange={(e) => handleTargetChange(dev.id, e.target.value)}
                              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-indigo-300 font-mono focus:border-indigo-500 focus:outline-none cursor-pointer max-w-[150px] truncate"
                          >
                              <option value="">-- Default --</option>
                              {events.map(ev => (
                                  <option key={ev.id} value={ev.id}>{ev.name} (ID: {ev.id})</option>
                              ))}
                          </select>
                      </div>
                  )}

                </div>
              )})
            )}
          </div>
        </div>
        
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center border-b border-slate-800 pb-2"><Network className="w-4 h-4 mr-2 text-cyan-400"/> Target Routing</h3>
          <div className="grid grid-cols-1 gap-4">
            <div><label className="block text-xs font-mono text-slate-500 mb-1">Target UDP IP Address</label><input type="text" name="udpIp" value={scenario?.udpIp || ''} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-cyan-400 font-mono" /></div>
            <div><label className="block text-xs font-mono text-slate-500 mb-1">Target UDP Port</label><input type="number" name="udpPort" value={scenario?.udpPort || 5005} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-cyan-400 font-mono" /></div>
          </div>
        </div>
        <div className="md:col-span-2 flex justify-end"><button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-8 py-3 rounded text-sm shadow-lg cursor-pointer"><Save className="w-4 h-4 inline mr-2" />SAVE SCENARIO ARCHITECTURE</button></div>
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
    overrideCounts, setOverrideCounts, getAlertCount, activeWorkspace 
}) => {
  const safeDevices = Array.isArray(devices) ? devices : [];
  
  const activeFleet = useMemo(() => safeDevices.filter(d => d && (scenario?.activeDevices || []).includes(d.id) && (d.workspace || 'Default') === activeWorkspace), [safeDevices, scenario, activeWorkspace]);
  const targetTotalAlerts = useMemo(() => activeFleet.reduce((acc, dev) => acc + getAlertCount(dev), 0), [activeFleet, overrideCounts]);

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
        <div><h2 className="text-2xl font-bold text-rose-400 flex items-center space-x-2"><BellDot className="w-6 h-6" /> <span>Alert Generator</span></h2><p className="text-slate-400 text-sm mt-1">Executing {targetTotalAlerts} total alerts across bounded sensor arrays in {activeWorkspace}.</p></div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center border-b border-slate-800 pb-2"><Target className="w-4 h-4 mr-2 text-rose-400"/> Payload Overrides</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-2 mb-5">
              {activeFleet.length === 0 ? (
                 <div className="text-xs font-mono text-slate-500 bg-slate-950 p-3 rounded border border-slate-800">No active sensors bound in scenario.</div>
              ) : (
                 activeFleet.map(dev => (
                   <div key={dev.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 p-2 rounded">
                     <div><span className="text-sm font-bold text-slate-300">{dev.id}</span><span className="text-[10px] text-slate-500 ml-2 uppercase">({dev.type})</span></div>
                     <input type="number" min="0" value={getAlertCount(dev)} onChange={(e) => handleCountOverride(dev.id, e.target.value)} disabled={simIsRunning} className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-rose-400 font-mono text-center text-sm disabled:opacity-50 focus:border-rose-500 focus:outline-none" />
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
                  <input type="number" step="0.0001" name="minDelaySec" value={alertConfig?.minDelaySec || 0} onChange={handleChange} disabled={simIsRunning} placeholder="Min" className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-amber-400 font-mono disabled:opacity-50 focus:border-amber-500 focus:outline-none" />
                  <input type="number" step="0.0001" name="maxDelaySec" value={alertConfig?.maxDelaySec || 0} onChange={handleChange} disabled={simIsRunning} placeholder="Max" className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-amber-400 font-mono disabled:opacity-50 focus:border-amber-500 focus:outline-none" />
                </div>
              </div>
            </div>

            <div className="mb-6">
              <TelemetryProgress packetsSent={simProgress} totalPackets={targetTotalAlerts} />
            </div>

            {!simIsRunning ? ( <button onClick={startSimulation} className="w-full flex justify-center items-center space-x-2 bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded text-sm shadow-lg cursor-pointer"><Play className="w-4 h-4 fill-current" /> <span>ENGAGE TRANSMITTER</span></button> ) : (
              <button onClick={stopSimulation} className="w-full flex justify-center items-center space-x-2 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded text-sm shadow-lg animate-pulse cursor-pointer"><Square className="w-4 h-4 fill-current" /> <span>ABORT</span></button> )}
          </div>
        </div>
        <div className="xl:col-span-2">
          <div className="bg-[#0A0A0A] border border-slate-800 rounded-lg h-full flex flex-col overflow-hidden shadow-2xl relative">
            <div className="bg-slate-900 border-b border-slate-800 px-5 py-3 flex justify-between items-center z-10"><h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center font-mono"><Terminal className="w-4 h-4 mr-2 text-slate-500"/> Live UDP Telemetry</h3></div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed space-y-1">
              {(!simLogs || simLogs.length === 0) ? <div className="text-slate-600 mt-2">Waiting for simulation to begin...</div> : simLogs.map((log, idx) => (<div key={idx} className={`flex space-x-3 ${log.type === 'error' ? 'text-rose-400' : log.type === 'info' ? 'text-cyan-400' : 'text-emerald-400'}`}><span className="opacity-50 shrink-0">[{log.time}]</span><span className="break-all">{log.msg}</span></div>))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// VIEW 4: TACTICAL MAP WITH LAYER CONTROL PANEL
// ==========================================
// Change this line:
  const MapView = ({ devices = [], alerts = [], simIsRunning, simProgress, totalAlertsGenerated, activeWorkspace, clearAlerts }) => {
  const mapContainerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState({});
  const [isLayerPanelOpen, setIsLayerPanelOpen] = useState(false);

  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeAlerts = Array.isArray(alerts) ? alerts : [];

  const mapDevices = useMemo(() => safeDevices.filter(d => (d.workspace || 'Default') === activeWorkspace), [safeDevices, activeWorkspace]);
  const mapCenter = useMemo(() => mapDevices.length > 0 && mapDevices[0].lat ? [mapDevices[0].lat, mapDevices[0].lng] : [27.2285, 77.4320], [mapDevices]);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      if (mapContainerRef.current) mapContainerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    if (simIsRunning) setShowAll(false);
  }, [simIsRunning]);

  const toggleLayer = (layerKey) => {
    setHiddenLayers(prev => ({ ...prev, [layerKey]: !prev[layerKey] }));
  };

  const kmlSources = useMemo(() => Array.from(new Set(
    mapDevices.filter(d => d && d.type && d.type.toUpperCase().includes('ENV')).map(d => d.sourceFile || 'Uploaded KML')
  )), [mapDevices]);

  const getSourceColor = (srcName) => {
    const match = mapDevices.find(d => (d.sourceFile || 'Uploaded KML') === srcName);
    return match ? (match.color || '#3b82f6') : '#3b82f6';
  };

  const visibleDevices = useMemo(() => mapDevices.filter(dev => {
    if (!dev || !dev.type) return false;
    if (dev.type.toUpperCase().includes('ENV')) {
      return !hiddenLayers[dev.sourceFile || 'Uploaded KML'];
    }
    return !hiddenLayers['HARDWARE_SENSORS'];
  }), [mapDevices, hiddenLayers]);

  const displayedAlerts = useMemo(() => 
    (showAll ? safeAlerts : safeAlerts.slice(-1000)).filter(() => !hiddenLayers['LIVE_ALERTS']), 
  [safeAlerts, showAll, hiddenLayers]);

  return (
    <div className="p-6 space-y-4 max-w-[1600px] mx-auto h-[calc(100vh-4rem)] flex flex-col font-sans relative">
      
      {!isFullscreen && (
        <div className="border-b border-slate-800 pb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center space-x-2">
              <Globe className="w-6 h-6 text-cyan-400" />
              <span>Tactical Map Visualizer <span className="text-xs font-mono text-slate-500 ml-2">[{activeWorkspace}]</span></span>
            </h2>
          </div>
          <div className="flex space-x-3">
              {/* --- NEW BUTTON GOES HERE --- */}
              <button 
                  onClick={clearAlerts}
                  disabled={simIsRunning}
                  className="flex items-center space-x-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 border border-slate-700 rounded px-3 py-1 cursor-pointer transition-colors"
                  title="Clear all alerts from map"
              >
                  <Trash2 className="w-4 h-4 text-slate-400" />
                  <span className="text-xs font-mono text-slate-300 font-bold">CLEAR ALERTS</span>
              </button>
              {/* ---------------------------- */}
              
              <div className="flex items-center space-x-2 bg-rose-950/40 border border-rose-900 rounded px-3 py-1">
                  <Target className="w-4 h-4 text-rose-500" />
                  <span className="text-xs font-mono text-rose-400 font-bold">TOTAL GENERATED: {totalAlertsGenerated}</span>
              </div>
          </div>
        </div>
      )}
      <div ref={mapContainerRef} className={`relative z-0 flex ${isFullscreen ? 'w-screen h-screen bg-slate-950' : 'flex-1 rounded-xl overflow-hidden border border-slate-700 shadow-2xl'}`}>
        
        <div className="absolute top-24 left-4 z-[1000]">
          {!isLayerPanelOpen ? (
            <button onClick={() => setIsLayerPanelOpen(true)} className="bg-slate-900/90 backdrop-blur border border-slate-700 p-2.5 rounded-lg shadow-2xl hover:bg-slate-800 transition-colors flex items-center space-x-2 group cursor-pointer">
              <Layers className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform" />
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">Layers</span>
            </button>
          ) : (
            <div className="bg-slate-900/95 backdrop-blur border border-slate-700 rounded-lg shadow-2xl p-4 w-64 max-h-[80vh] overflow-y-auto">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center">
                  <FolderTree className="w-4 h-4 mr-2 text-cyan-400" /> Tactical Layers
                </h4>
                <button onClick={() => setIsLayerPanelOpen(false)} className="text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"><X className="w-4 h-4" /></button>
              </div>

              <div className="space-y-2 text-xs font-mono">
                <label className="flex items-center justify-between p-2 rounded hover:bg-slate-800/50 cursor-pointer select-none">
                  <div className="flex items-center space-x-2">
                    <input type="checkbox" checked={!hiddenLayers['HARDWARE_SENSORS']} onChange={() => toggleLayer('HARDWARE_SENSORS')} className="w-3.5 h-3.5 accent-cyan-500 rounded cursor-pointer" />
                    <span className="text-slate-200 font-bold">Hardware Sensors</span>
                  </div>
                  <span className="w-3 h-3 rounded-full bg-amber-400 inline-block"></span>
                </label>

                <label className="flex items-center justify-between p-2 rounded hover:bg-slate-800/50 cursor-pointer select-none">
                  <div className="flex items-center space-x-2">
                    <input type="checkbox" checked={!hiddenLayers['LIVE_ALERTS']} onChange={() => toggleLayer('LIVE_ALERTS')} className="w-3.5 h-3.5 accent-cyan-500 rounded cursor-pointer" />
                    <span className="text-slate-200 font-bold">Live UDP Alerts</span>
                  </div>
                  <span className="w-3 h-3 rounded-full bg-rose-500 inline-block"></span>
                </label>

                {kmlSources.length > 0 && <div className="border-t border-slate-800 pt-2 mt-2 text-[10px] text-slate-400 font-bold uppercase tracking-wider">Uploaded KML Files</div>}
                
                {kmlSources.map((srcName) => {
                  const badgeColor = getSourceColor(srcName);
                  const isChecked = !hiddenLayers[srcName];
                  return (
                    <label key={srcName} className="flex items-center justify-between p-2 rounded hover:bg-slate-800/50 cursor-pointer select-none">
                      <div className="flex items-center space-x-2 truncate pr-2">
                        <input type="checkbox" checked={isChecked} onChange={() => toggleLayer(srcName)} className="w-3.5 h-3.5 accent-emerald-500 rounded cursor-pointer shrink-0" />
                        <span className={`truncate ${isChecked ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>{srcName}</span>
                      </div>
                      <span className="w-3 h-3 rounded border border-slate-500 shrink-0" style={{ backgroundColor: badgeColor }}></span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end space-y-2">
          <button onClick={toggleFullscreen} className="bg-slate-900/90 backdrop-blur border border-slate-700 p-2.5 rounded-lg shadow-2xl hover:bg-slate-800 transition-colors text-white group cursor-pointer" title="Toggle Fullscreen">
            {isFullscreen ? <Minimize className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform" /> : <Maximize className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform" />}
          </button>

          {safeAlerts.length > 1000 && !simIsRunning && (
              <button 
                  onClick={() => setShowAll(!showAll)}
                  className={`font-bold py-2 px-4 rounded shadow-lg text-xs flex items-center transition-colors cursor-pointer ${showAll ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-rose-600 hover:bg-rose-500 text-white'}`}
              >
                  {showAll ? 'SHOW LATEST 1000 ONLY' : `LOAD ALL ${safeAlerts.length} ALERTS (MAY LAG)`}
              </button>
          )}
        </div>

        {isFullscreen && (
          <div className="absolute bottom-6 left-6 z-[1000] flex items-center space-x-3">
             {/* --- NEW BUTTON GOES HERE --- */}
             <button 
                  onClick={clearAlerts}
                  disabled={simIsRunning}
                  className="flex items-center space-x-2 bg-slate-900/90 backdrop-blur hover:bg-slate-800 disabled:opacity-50 border border-slate-700 rounded px-4 py-2 shadow-2xl cursor-pointer transition-colors"
             >
                  <Trash2 className="w-5 h-5 text-slate-400" />
                  <span className="text-sm font-mono text-slate-300 font-bold">CLEAR ALERTS</span>
             </button>
             {/* ---------------------------- */}

             <div className="flex items-center space-x-2 bg-rose-950/90 backdrop-blur border border-rose-900 rounded px-4 py-2 shadow-2xl">
                 <Target className="w-5 h-5 text-rose-500" />
                 <span className="text-sm font-mono text-rose-400 font-bold">TOTAL GENERATED: {totalAlertsGenerated}</span>
             </div>
          </div>
        )}

        <MapContainer key={mapCenter.join(',')} center={mapCenter} zoom={13} className="h-full w-full z-0" style={{ background: '#f8fafc' }} preferCanvas={true}>
          <TileLayer attribution='&copy; CartoDB' url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
          
          {visibleDevices.map((dev, idx) => {
            if (!dev || !dev.type) return null;
            const isEnv = dev.type.toUpperCase().includes('ENV');
            const isCam = dev.type.toUpperCase().includes('CAM');
            const isRadar = dev.type.toUpperCase().includes('RADAR');
            const layerColor = dev.color || "#3b82f6";
            const safePoly = Array.isArray(dev.polygon) ? dev.polygon : [];
            const isLine = ['ROAD', 'RAILWAY'].includes(dev.envCategory);
            
            return (
              <React.Fragment key={dev.id || `dev-${idx}`}>
                {isEnv && dev.isPolygon && safePoly.length > 0 && (
                  isLine ? (
                    <LeafletPolyline positions={safePoly} pathOptions={{ color: layerColor, weight: 2.5 }}>
                      <Popup className="font-mono text-xs"><strong>{dev.id}</strong><br/>File: {dev.sourceFile}</Popup>
                    </LeafletPolyline>
                  ) : (
                    <LeafletPolygon positions={safePoly} pathOptions={{ color: layerColor, fillColor: layerColor, fillOpacity: dev.envCategory === 'BUILDING' ? 0.55 : 0.35, weight: dev.envCategory === 'PERIMETER' ? 3.5 : 1.5 }}>
                      <Popup className="font-mono text-xs"><strong>{dev.id}</strong><br/>File: {dev.sourceFile}</Popup>
                    </LeafletPolygon>
                  )
                )}
                
                {isEnv && !dev.isPolygon && dev.lat != null && dev.lng != null && (
                  <CircleMarker center={[dev.lat, dev.lng]} radius={4} pathOptions={{ color: '#ffffff', fillColor: layerColor, fillOpacity: 1, weight: 1.5 }}><Popup className="font-mono text-xs"><strong>{dev.id}</strong><br/>File: {dev.sourceFile}</Popup></CircleMarker>
                )}

                {dev.isPolygon && safePoly.length > 0 && !isEnv && (
                  <LeafletPolygon positions={safePoly} pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.3, weight: 3 }}><Popup className="font-mono text-xs"><strong>{dev.id}</strong><br/>PIDS Perimeter Array</Popup></LeafletPolygon>
                )}

                {!dev.isPolygon && isCam && dev.lat != null && dev.lng != null && (
                  <LeafletPolygon positions={getCameraFovPolygon(dev.lat, dev.lng, dev.outerRange, dev.azimuth, dev.fov)} pathOptions={{ color: '#eab308', fillColor: '#eab308', fillOpacity: 0.25, weight: 1.5 }} />
                )}

                {!dev.isPolygon && isRadar && dev.lat != null && dev.lng != null && (
                  <><Circle center={[dev.lat, dev.lng]} radius={dev.outerRange || 100} pathOptions={{ color: '#ef4444', fillOpacity: 0.1, weight: 1.5, dashArray: "5, 5" }} /><Circle center={[dev.lat, dev.lng]} radius={dev.innerRange || 0} pathOptions={{ color: '#ef4444', fillOpacity: 0.0, weight: 2 }} /></>
                )}

                {!dev.isPolygon && !isEnv && dev.lat != null && dev.lng != null && (
                  <CircleMarker center={[dev.lat, dev.lng]} radius={5} pathOptions={{ color: '#0f172a', fillColor: isRadar ? '#ef4444' : '#eab308', fillOpacity: 1, weight: 2 }}><Popup className="font-mono text-xs"><strong className="block text-sm mb-1">{dev.id}</strong>Type: {dev.type}</Popup></CircleMarker>
                )}
              </React.Fragment>
            );
          })}

          {displayedAlerts.map((alert, idx) => {
             const lat = alert.latitude ?? (alert.loc ? alert.loc[0] : null);
             const lng = alert.longitude ?? (alert.loc ? alert.loc[1] : null);
             if (lat == null || lng == null) return null;
             
             const type = String(alert.sensor_type || alert.type || 'UNKNOWN').toUpperCase();
             const pinColor = type.includes('RADAR') ? '#dc2626' : type.includes('CAM') ? '#facc15' : '#22c55e';
             return (<CircleMarker key={`alert-${alert.alert_id || alert.id || idx}`} center={[lat, lng]} radius={5} pathOptions={{ color: '#ffffff', fillColor: pinColor, fillOpacity: 1, weight: 1 }}><Popup className="font-mono text-xs"><strong className="block text-sm mb-1">{type} ALERT</strong>Track ID: {alert.alert_id || alert.id || 'N/A'}</Popup></CircleMarker>);
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
  const [generatingId, setGeneratingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: 'timestamp', direction: 'desc' });

  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [rangeReportName, setRangeReportName] = useState('Custom_Time_Range_Report');
  const [isRangeGenerating, setIsRangeGenerating] = useState(false);

  const handleGenerate = async (run) => {
    setGeneratingId(run.id);
    try {
      const response = await fetch(`/api/export/run/${run.id}`);
      const data = await response.json();

      const kmlBlob = new Blob([data.kml_content], { type: 'application/vnd.google-earth.kml+xml' });
      const link1 = document.createElement('a'); link1.href = URL.createObjectURL(kmlBlob); link1.download = `${run.scenarioName}_Output.kml`; link1.click();
      const csvBlob = new Blob([data.csv_content], { type: 'text/csv' });
      const link2 = document.createElement('a'); link2.href = URL.createObjectURL(csvBlob); link2.download = `${run.scenarioName}_Output.csv`; link2.click();
    } catch (err) { 
      alert("Failed to generate export files from backend.");
    } finally {
      setGeneratingId(null);
    }
  };

  const handleRangeGenerate = async (e) => {
    e.preventDefault();
    if (!rangeStart || !rangeEnd) return alert("Please select both a Start and End date/time.");
    
    setIsRangeGenerating(true);
    try {
      const response = await fetch('/api/export/range', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            startTime: new Date(rangeStart).toISOString(),
            endTime: new Date(rangeEnd).toISOString(),
            reportName: rangeReportName
        })
      });
      const data = await response.json();
      const kmlBlob = new Blob([data.kml_content], { type: 'application/vnd.google-earth.kml+xml' });
      const link1 = document.createElement('a'); link1.href = URL.createObjectURL(kmlBlob); link1.download = `${rangeReportName}.kml`; link1.click();
      const csvBlob = new Blob([data.csv_content], { type: 'text/csv' });
      const link2 = document.createElement('a'); link2.href = URL.createObjectURL(csvBlob); link2.download = `${rangeReportName}.csv`; link2.click();
    } catch (err) {
      alert("Failed to generate range report from database.");
    } finally {
      setIsRangeGenerating(false);
    }
  };

  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') { direction = 'desc'; }
    setSortConfig({ key, direction });
  };

  const safeCompletedRuns = Array.isArray(completedRuns) ? completedRuns : [];
  
  const sortedRuns = useMemo(() => {
    const filteredRuns = safeCompletedRuns.filter(run => 
        run && run.scenarioName && String(run.scenarioName).toLowerCase().includes(searchTerm.toLowerCase())
    );
    return [...filteredRuns].sort((a, b) => {
      let aValue = a[sortConfig.key];
      let bValue = b[sortConfig.key];

      if (sortConfig.key === 'timestamp') {
          aValue = new Date(a.timestamp || 0).getTime();
          bValue = new Date(b.timestamp || 0).getTime();
      } else if (sortConfig.key === 'alertsGenerated') {
          aValue = parseInt(a.alertsGenerated, 10) || 0;
          bValue = parseInt(b.alertsGenerated, 10) || 0;
      } else {
          aValue = String(a.scenarioName || '').toLowerCase();
          bValue = String(b.scenarioName || '').toLowerCase();
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [safeCompletedRuns, searchTerm, sortConfig]);

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div><h2 className="text-2xl font-bold text-emerald-400 flex items-center space-x-2"><FileOutput className="w-6 h-6" /> <span>Reports & Export</span></h2></div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center border-b border-slate-800 pb-3">
          <Calendar className="w-4 h-4 mr-2 text-emerald-400" /> On-Demand Database Range Exporter
        </h3>
        <form onSubmit={handleRangeGenerate} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1">Start Date & Time</label>
            <input 
              type="datetime-local" step="1" required 
              value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} 
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm text-emerald-400 font-mono focus:border-emerald-500 focus:outline-none" 
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1">End Date & Time</label>
            <input 
              type="datetime-local" step="1" required 
              value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} 
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm text-emerald-400 font-mono focus:border-emerald-500 focus:outline-none" 
            />
          </div>
          <div>
            <button 
              type="submit" disabled={isRangeGenerating}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold py-2.5 px-4 rounded text-xs flex items-center justify-center shadow-lg transition-colors cursor-pointer"
            >
              <Download className="w-4 h-4 mr-2" /> {isRangeGenerating ? "QUERYING & COMPUTING..." : "GENERATE RANGE KML/CSV"}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden shadow-sm">
        <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center">
                <CheckCircle className="w-4 h-4 mr-2 text-cyan-400"/> Completed Simulation Runs ({sortedRuns.length})
            </h3>
            <div className="relative w-64">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                <input 
                    type="text" placeholder="Search by Designation..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-700 rounded text-sm text-slate-200 focus:border-emerald-500 focus:outline-none transition-colors"
                />
            </div>
        </div>

        <div className="p-0 max-h-[600px] overflow-y-auto">
          {sortedRuns.length === 0 ? <div className="p-10 text-center text-slate-500 font-mono text-sm">No individual scenario simulations completed in this session. Use the Date Range Exporter above anytime!</div> : (
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-950 text-slate-400 font-mono text-xs sticky top-0 border-b border-slate-800">
                  <tr>
                      <th onClick={() => requestSort('timestamp')} className="p-4 cursor-pointer hover:text-emerald-400 transition-colors">
                          Timestamp <ArrowUpDown className="w-3 h-3 inline ml-1 opacity-50" />
                      </th>
                      <th onClick={() => requestSort('scenarioName')} className="p-4 cursor-pointer hover:text-emerald-400 transition-colors">
                          Designation <ArrowUpDown className="w-3 h-3 inline ml-1 opacity-50" />
                      </th>
                      <th onClick={() => requestSort('alertsGenerated')} className="p-4 cursor-pointer hover:text-emerald-400 transition-colors">
                          Alerts Transmitted <ArrowUpDown className="w-3 h-3 inline ml-1 opacity-50" />
                      </th>
                      <th className="p-4 text-right">Action</th>
                  </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {sortedRuns.map((run) => {
                  const isCurrentGenerating = generatingId === run.id;
                  const isAnyGenerating = generatingId !== null;

                  return (
                    <tr key={run.id} className="hover:bg-slate-800/30">
                      <td className="p-4 text-slate-300 font-mono text-xs">{run.timestamp}</td>
                      <td className="p-4 font-bold text-emerald-400">{run.scenarioName}</td>
                      <td className="p-4 text-slate-300 font-mono">{run.alertsGenerated} Packets</td>
                      <td className="p-4 text-right flex justify-end items-center space-x-2">
                          <button 
                            onClick={() => handleGenerate(run)} 
                            disabled={isAnyGenerating} 
                            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold px-4 py-2 rounded transition-colors text-xs flex items-center cursor-pointer"
                          >
                              <Download className="w-3 h-3 mr-2" /> {isCurrentGenerating ? "GENERATING..." : "GENERATE OUTPUT"}
                          </button>
                      </td>
                    </tr>
                  );
                })}
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [currentView, setCurrentView] = useState('Device Configuration');
  const [dbStatus, setDbStatus] = useState('Checking...');
  
  // NEW: State for dynamically loaded sensor events
  const [sensorEvents, setSensorEvents] = useState({});

  const [sensorSchemas, setSensorSchemas] = useState([]); 
  const [devices, setDevices] = useState([]);
  
  const [customWorkspaces, setCustomWorkspaces] = useState(['Default']);
  const [activeWorkspace, setActiveWorkspace] = useState(() => localStorage.getItem('simcore_workspace') || 'Default');

  const [scenario, setScenario] = useState({ name: 'Operation Alpha', activeDevices: [], udpIp: '127.0.0.1', udpPort: 5005, workspace: 'Default', kmlProbabilities: {}, deviceAlertMapping: {} });
  const [alertConfig, setAlertConfig] = useState({ minDelaySec: 0.0001, maxDelaySec: 0.0005 });
  const [completedRuns, setCompletedRuns] = useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [simIsRunning, setSimIsRunning] = useState(false);
  const [simProgress, setSimProgress] = useState(0);
  const [overrideCounts, setOverrideCounts] = useState({});
  const previousRunningState = useRef(false);

  const [simLogs, setSimLogs] = useState(() => {
    try {
      const saved = localStorage.getItem('simcore_telemetry');
      return saved ? JSON.parse(saved) : [];
    } catch (e) { return []; }
  });

  useEffect(() => {
    localStorage.setItem('simcore_telemetry', JSON.stringify(simLogs));
  }, [simLogs]);

  useEffect(() => {
    localStorage.setItem('simcore_workspace', activeWorkspace);
  }, [activeWorkspace]);

  const allWorkspaces = useMemo(() => {
      const wsSet = new Set(devices.map(d => d.workspace || 'Default'));
      customWorkspaces.forEach(ws => wsSet.add(ws));
      return Array.from(wsSet);
  }, [devices, customWorkspaces]);

  const getAlertCount = (dev) => overrideCounts[dev.id] !== undefined ? overrideCounts[dev.id] : (dev.alertCount || 0);

  const fetchHistory = () => {
    fetch('/api/runs')
      .then(res => res.json()).then(data => { if(Array.isArray(data)) setCompletedRuns(data); })
      .catch(e => console.error("History fetch failed"));
  };

  useEffect(() => {
    // NEW: Fetch Hardcoded Events from Backend
    fetch('/api/config/sensor-events')
      .then(res => res.json())
      .then(data => setSensorEvents(data))
      .catch(e => console.error("Failed to load sensor events"));

    fetch('/api/config/schemas')
      .then(res => { if (res.ok) { setDbStatus('CONNECTED'); return res.json(); } throw new Error(); })
      .then(data => { setSensorSchemas(Array.isArray(data) ? data : []); })
      .catch(e => setDbStatus('DISCONNECTED'));

    fetch('/api/config/devices')
      .then(res => res.json()).then(data => { setDevices(Array.isArray(data) ? data : []); }).catch(e => console.error(e));

    fetchHistory();
  }, []);

  useEffect(() => {
    fetch(`/api/state/scenario/${activeWorkspace}`)
      .then(res => res.json()).then(data => { if(data && data.name) setScenario(data); }).catch(e => console.error(e));
  }, [activeWorkspace]);

  useEffect(() => {
    fetch('/api/state/alerts')
      .then(res => res.json()).then(data => { setActiveAlerts(Array.isArray(data) ? data : []); }).catch(e => console.error(e));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
        fetch('/api/engine/status')
            .then(res => res.json())
            .then(data => {
                if(!data) return;
                
                setSimIsRunning(prev => prev === !!data.is_running ? prev : !!data.is_running);
                setSimProgress(prev => prev === data.progress ? prev : (data.progress || 0)); 
                
                if (Array.isArray(data.logs) && data.logs.length > 0) {
                    setSimLogs(prev => {
                        if (prev.length === data.logs.length && !data.is_running) return prev;
                        return data.logs;
                    });
                }
                
                if (data.is_running || (Array.isArray(data.map_alerts) && data.map_alerts.length > 0)) {
                    setActiveAlerts(prev => {
                        if (prev.length === data.map_alerts.length && !data.is_running) return prev;
                        return Array.isArray(data.map_alerts) ? data.map_alerts : [];
                    });
                }
                
                if (previousRunningState.current === true && data.is_running === false) {
                    fetchHistory();
                    fetch('/api/state/alerts')
                        .then(r => r.json())
                        .then(alerts => setActiveAlerts(prev => {
                            const newAlerts = Array.isArray(alerts) ? alerts : [];
                            if (prev.length === newAlerts.length) return prev;
                            return newAlerts;
                        }));
                }
                previousRunningState.current = !!data.is_running;
            })
            .catch(() => {});
    }, 500); 
    
    return () => clearInterval(interval);
  }, []);

  const startSimulation = async () => {
    const safeDevices = Array.isArray(devices) ? devices : [];
    
    const activeFleet = safeDevices.filter(d => d && (scenario?.activeDevices || []).includes(d.id));
    const environmentFleet = safeDevices.filter(d => d && d.type && String(d.type).toUpperCase().includes('ENV') && d.workspace === scenario?.workspace);
    
    const targetTotalAlerts = activeFleet.reduce((acc, dev) => acc + getAlertCount(dev), 0);

    if (activeFleet.length === 0) return alert("MISSION ABORT: No active sensors bound.");
    if (targetTotalAlerts <= 0) return alert("MISSION ABORT: Target payload is 0.");

    setSimIsRunning(true);
    setSimProgress(0);
    setActiveAlerts([]);
    setSimLogs([{ time: new Date().toLocaleTimeString(), msg: `SYSTEM: Engaging '${scenario?.name || 'Simulation'}'. Requesting transmission...`, type: 'info' }]);

    const activeFleetWithOverrides = activeFleet.map(dev => ({ ...dev, alertCount: getAlertCount(dev) }));
    
    // Explicitly pass both KML Probabilities AND Event Mapping into the engine
    const payload = {
        scenarioName: scenario?.name || 'Simulation',
        udpIp: scenario?.udpIp || '127.0.0.1',
        udpPort: parseInt(scenario?.udpPort, 10) || 5005,
        activeDevices: activeFleetWithOverrides,
        environmentDevices: environmentFleet,
        alertConfig: alertConfig,
        sensorSchemas: Array.isArray(sensorSchemas) ? sensorSchemas : [],
        kmlProbabilities: scenario?.kmlProbabilities || {},
        deviceAlertMapping: scenario?.deviceAlertMapping || {}
    };

    try {
        await fetch('/api/engine/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
    } catch (e) {
        setSimIsRunning(false);
        alert("Failed to start engine.");
    }
  };

  const stopSimulation = () => {
    fetch('/api/engine/stop', { method: 'POST' });
  };
  // --- PASTE THIS NEW FUNCTION RIGHT BELOW stopSimulation ---
  const handleSensorEventsUpload = async (event) => {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    try {
        const text = await files[0].text();
        const parsedData = JSON.parse(text);
        
        // Validate structure matches SENSOR_EVENTS.json
        if (!parsedData.protocolName || !Array.isArray(parsedData.fields)) {
            throw new Error("Invalid format. Expected 'protocolName' and 'fields' array.");
        }

        const response = await fetch('/api/config/sensor-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsedData)
        });

        if (response.ok) {
            alert("✅ SUCCESS: Global Sensor Events saved to Database!");
            // Instantly refresh the UI dropdowns
            const updatedEvents = await fetch('/api/config/sensor-events').then(res => res.json());
            setSensorEvents(updatedEvents);
        } else {
            const errText = await response.text();
            alert("❌ PYTHON REJECTED THE DATA:\n" + errText);
        }
    } catch (err) { 
        alert(`🚨 EVENT UPLOAD ERROR in ${files[0].name}!\n\nDetails: ${err.message}`); 
    }
  };
  // --------------------------------------------------------
  const handleClearAlerts = async () => {
    if(window.confirm("Are you sure you want to clear all alerts from the map? This will not delete them from the database history.")) {
        // Clear Frontend
        setActiveAlerts([]);
        // Clear Backend Engine Memory
        try {
            await fetch('/api/engine/clear-alerts', { method: 'POST' });
        } catch (err) {
            console.error("Failed to clear backend memory:", err);
        }
    }
  };

  const menuItems = [
    { name: 'Device Configuration', icon: Settings },
    { name: 'Scenario Builder', icon: Sliders },
    { name: 'Tactical Map', icon: Globe },
    { name: 'Alert Generator', icon: BellDot },
    { name: 'Reports / Export', icon: FileOutput },
  ];

  const totalAlertsGen = simIsRunning ? simProgress : (completedRuns.length > 0 ? completedRuns[0].alertsGenerated : 0);

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans selection:bg-cyan-900 overflow-hidden">
      
      <aside className={`bg-slate-900 border-slate-800 flex flex-col shrink-0 z-20 shadow-2xl transition-all duration-300 ease-in-out overflow-hidden ${isSidebarOpen ? 'w-64 border-r' : 'w-0 border-r-0'}`}>
        <div className="w-64 h-full flex flex-col">
          <div className="h-16 border-b border-slate-800 flex items-center px-6"><Shield className="w-6 h-6 text-emerald-400 mr-3" /><span className="font-bold tracking-wider text-lg">SIMCORE <span className="text-xs text-slate-500">v2.5</span></span></div>
          <nav className="flex-1 py-4 overflow-y-auto">
            <ul className="space-y-1">
              {menuItems.map((item) => {
                const Icon = item.icon; const isActive = currentView === item.name;
                return (<li key={item.name}><button onClick={() => setCurrentView(item.name)} className={`w-full flex items-center px-6 py-3 text-sm font-medium transition-colors cursor-pointer ${isActive ? 'bg-emerald-950/30 text-emerald-400 border-r-2 border-emerald-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}><Icon className={`w-4 h-4 mr-3 ${isActive ? 'text-emerald-400' : 'opacity-70'}`} /> {item.name}</button></li>);
              })}
            </ul>
          </nav>
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative overflow-hidden bg-slate-950">
        <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="mr-4 p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer">
               <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-sm font-bold text-slate-300 uppercase tracking-widest">{currentView}</h1>
          </div>
          <div className="flex items-center space-x-4">
            <div className={`flex items-center space-x-2 px-3 py-1.5 rounded-md border font-mono text-xs ${dbStatus === 'CONNECTED' ? 'bg-emerald-950 border-emerald-800 text-emerald-400' : 'bg-rose-950 border-rose-800 text-rose-400'}`}>
                <span className={`w-2 h-2 rounded-full ${dbStatus === 'CONNECTED' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                <span>DB: {dbStatus}</span>
            </div>
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-md bg-slate-950 border border-slate-800 font-mono text-xs"><span className={`w-2 h-2 rounded-full ${simIsRunning ? 'bg-rose-500 animate-pulse' : 'bg-amber-500'}`}></span><span className="text-slate-300">ENGINE: {simIsRunning ? 'TRANSMITTING' : 'IDLE'}</span></div>
          </div>
        </header>
        
        <div className="flex-1 overflow-y-auto">
         {currentView === 'Device Configuration' && <DeviceConfigView devices={devices} setDevices={setDevices} sensorSchemas={sensorSchemas} setSensorSchemas={setSensorSchemas} allWorkspaces={allWorkspaces} setCustomWorkspaces={setCustomWorkspaces} activeWorkspace={activeWorkspace} setActiveWorkspace={setActiveWorkspace} handleSensorEventsUpload={handleSensorEventsUpload} />}
          {currentView === 'Scenario Builder' && <ScenarioBuilderView devices={devices} scenario={scenario} setScenario={setScenario} sensorSchemas={sensorSchemas} activeWorkspace={activeWorkspace} sensorEvents={sensorEvents} />}
          
          {currentView === 'Tactical Map' && <MapView devices={devices} alerts={activeAlerts} simIsRunning={simIsRunning} simProgress={simProgress} totalAlertsGenerated={totalAlertsGen} activeWorkspace={activeWorkspace} clearAlerts={handleClearAlerts} />}
          {currentView === 'Alert Generator' && <AlertGeneratorView devices={devices} scenario={scenario} alertConfig={alertConfig} setAlertConfig={setAlertConfig} setCompletedRuns={setCompletedRuns} setActiveAlerts={setActiveAlerts} sensorSchemas={sensorSchemas} simIsRunning={simIsRunning} simLogs={simLogs} simProgress={simProgress} startSimulation={startSimulation} stopSimulation={stopSimulation} overrideCounts={overrideCounts} setOverrideCounts={setOverrideCounts} getAlertCount={getAlertCount} activeWorkspace={activeWorkspace} />}
          {currentView === 'Reports / Export' && <ExportView completedRuns={completedRuns} />}
        </div>
      </main>
    </div>
  );
}