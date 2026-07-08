import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Shield, Settings, Server, MapPin, Trash2, CheckCircle, 
  Upload, Network, Clock, FileOutput, Save, BellDot, 
  Globe, Sliders, Play, Square, Terminal, CheckSquare, Download, Target,
  AlertTriangle, Search, ArrowUpDown, Calendar, Layers, FolderTree
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
const DeviceConfigView = ({ devices, setDevices, sensorSchemas, setSensorSchemas }) => {
  const [status, setStatus] = useState({ message: 'System Ready', type: 'info' });

  const safeDevices = Array.isArray(devices) ? devices : [];
  const hardwareSensors = useMemo(() => safeDevices.filter(d => d && d.type && !String(d.type).toUpperCase().includes('ENV')), [safeDevices]);
  const environmentFeatures = useMemo(() => safeDevices.filter(d => d && d.type && String(d.type).toUpperCase().includes('ENV')), [safeDevices]);

  const syncDevicesToDB = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8000/api/config/devices', {
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
    } catch (err) {
      alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message);
    }
  };

  const syncSchemasToDB = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8000/api/config/schemas', {
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
    } catch (err) {
      alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message);
    }
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
                    alertCount: parseInt(d.AlertCount || 0), packetChoice: d.PacketChoice || "", lat, lng, isPolygon, polygon: polygonArr
                };
            });
            combinedSensors = [...combinedSensors, ...parsedSensors];
        } catch (err) { alert(`🚨 FORMAT ERROR in ${file.name}!\n\nDetails: ${err.message}`); }
    }
    setDevices(prev => [...(Array.isArray(prev) ? prev : []), ...combinedSensors]);
    setStatus({ message: `Loaded ${combinedSensors.length} Sensors. Please click 'Save Sensors to DB'.`, type: 'info' });
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
    setStatus({ message: `Loaded ${combinedSchemas.length} Protocol Schemas. Please click 'Save Formats to DB'.`, type: 'info' });
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

            isolatedLayer.features.forEach((feat) => {
                combinedEnvs.push({
                    id: feat.name, type: "Environment", envCategory, sourceFile: file.name,
                    isPolygon: feat.geometryType === 'Polygon' || feat.geometryType === 'LineString', 
                    polygon: feat.coordinates,
                    lat: feat.coordinates[0]?.[0] || 0, lng: feat.coordinates[0]?.[1] || 0,
                    innerRange: 0, outerRange: 0, azimuth: 0, fov: 0, alertCount: 0, packetChoice: "",
                    color: feat.style.fillColor
                });
            });
        } catch (err) { alert(`🚨 KML SYNTAX ERROR in ${file.name}!`); }
    }
    setDevices(prev => [...(Array.isArray(prev) ? prev : []), ...combinedEnvs]);
    setStatus({ message: `Loaded ${combinedEnvs.length} GIS Features via MultiFileKMLParser. Click 'Save GIS to DB'.`, type: 'info' });
  };

  const removeDevice = (id) => {
    setDevices(safeDevices.filter(d => d.id !== id));
    fetch(`http://127.0.0.1:8000/api/config/devices/${id}`, { method: 'DELETE' }).catch(() => {});
  };

  const clearAllEnvironmentFeatures = async () => {
    if (!window.confirm(`Are you sure you want to remove all ${environmentFeatures.length} loaded GIS layers? Your hardware sensors will remain intact.`)) return;
    const envIds = environmentFeatures.map(f => f.id);
    setDevices(prev => (Array.isArray(prev) ? prev : []).filter(d => d.type && !String(d.type).toUpperCase().includes('ENV')));
    for (const id of envIds) {
      fetch(`http://127.0.0.1:8000/api/config/devices/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    setStatus({ message: "Cleared all Environment GIS Layers", type: 'info' });
  };

  const removeSchema = (name) => {
    setSensorSchemas((Array.isArray(sensorSchemas) ? sensorSchemas : []).filter(s => s.name !== name));
    fetch(`http://127.0.0.1:8000/api/config/schemas/${name}`, { method: 'DELETE' }).catch(() => {});
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div><h2 className="text-2xl font-bold text-emerald-400 flex items-center space-x-2"><Settings className="w-6 h-6" /> <span>Device Configuration</span></h2></div>
        <div className={`px-4 py-2 rounded font-mono text-xs font-bold border ${status.type === 'error' ? 'bg-rose-950/50 border-rose-800 text-rose-400' : 'bg-emerald-950/50 border-emerald-800 text-emerald-400'}`}>{status.message}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center"><Target className="w-4 h-4 mr-2 text-rose-400"/> Sensor Array Input</h3>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative">
            <input type="file" multiple accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSensorJsonUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Server className="w-8 h-8 text-slate-500 mx-auto mb-2" /><p className="text-sm font-bold text-slate-300">Upload JSON File(s)</p>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center"><Settings className="w-4 h-4 mr-2 text-fuchsia-400"/> Packet Format Input</h3>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative">
            <input type="file" multiple accept=".json" onClick={(e) => { e.target.value = null; }} onChange={handleSchemaUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <Server className="w-8 h-8 text-slate-500 mx-auto mb-2" /><p className="text-sm font-bold text-slate-300">Upload JSON Schema(s)</p>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center"><MapPin className="w-4 h-4 mr-2 text-emerald-400"/> Environment Input</h3>
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:bg-slate-800/50 transition-colors relative">
            <input type="file" multiple accept=".kml" onClick={(e) => { e.target.value = null; }} onChange={handleEnvironmentKmlUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <MapPin className="w-8 h-8 text-slate-500 mx-auto mb-2" /><p className="text-sm font-bold text-slate-300">Upload KML File(s)</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-6">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-lg flex flex-col overflow-hidden shadow-sm h-[380px]">
          <div className="bg-slate-850 border-b border-slate-800 px-5 py-4 flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center"><Server className="w-4 h-4 mr-2 text-indigo-400"/> Deployed Tactical Sensors ({hardwareSensors.length})</h3>
            <button onClick={syncDevicesToDB} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg"><Save className="w-4 h-4 mr-2" /> SAVE SENSORS TO DB</button>
          </div>
          <div className="flex-1 overflow-auto p-0">
            {hardwareSensors.length === 0 ? <div className="h-full flex flex-col items-center justify-center text-slate-600 font-mono text-sm">No hardware sensors loaded.</div> : (
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
                                {isMissingPacket && <AlertTriangle className="w-3 h-3 ml-1" />}
                            </div>
                        </td>
                        <td className="p-3 font-mono text-xs text-slate-400">{dev.isPolygon ? `PIDS FENCE (${Array.isArray(dev.polygon) ? dev.polygon.length : 0} pts)` : `${parseFloat(dev.lat || 0).toFixed(4)}, ${parseFloat(dev.lng || 0).toFixed(4)}`}</td>
                        <td className="p-3 font-mono text-cyan-400 text-xs">{dev.isPolygon ? `${dev.alertCount || 0} Target Alerts` : `${dev.innerRange || 0}-${dev.outerRange || 0}m | ${dev.alertCount || 0} Alerts`}</td>
                        <td className="p-3 text-right"><button onClick={() => removeDevice(dev.id)} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4 inline" /></button></td>
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
            <button onClick={syncSchemasToDB} className="bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg"><Save className="w-4 h-4 mr-2" /> SAVE FORMATS</button>
          </div>
          <div className="flex-1 overflow-auto">
            {(!sensorSchemas || sensorSchemas.length === 0) ? <div className="p-10 text-center text-slate-500 font-mono text-xs">No schemas loaded.</div> : (
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="bg-slate-950/50 text-slate-400 font-mono sticky top-0"><tr><th className="p-3">Protocol Match</th><th className="p-3 text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-800/50">
                  {sensorSchemas.map((schema, idx) => (
                    <tr key={schema.name || idx} className="hover:bg-slate-800/30">
                      <td className="p-3 font-bold text-fuchsia-400">{schema.name || 'UNKNOWN'} <span className="text-slate-500 font-normal">[{schema.separator || ','}]</span></td>
                      <td className="p-3 text-right"><button onClick={() => removeSchema(schema.name)} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4 inline" /></button></td>
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
            <Layers className="w-4 h-4 mr-2 text-emerald-400"/> Environment GIS Features ({environmentFeatures.length})
          </h3>
          <div className="flex items-center space-x-3">
            {environmentFeatures.length > 0 && (
              <button onClick={clearAllEnvironmentFeatures} className="bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-300 font-bold py-1.5 px-3 rounded text-xs flex items-center transition-colors">
                <Trash2 className="w-3.5 h-3.5 mr-1.5" /> CLEAR ALL GIS
              </button>
            )}
            <button onClick={syncDevicesToDB} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-4 rounded text-xs flex items-center shadow-lg">
              <Save className="w-4 h-4 mr-2" /> SAVE GIS TO DB
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-0">
          {environmentFeatures.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 font-mono text-sm">
              No KML Environment layers loaded. Upload KML files above to apply GIS constraints.
            </div>
          ) : (
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-950/50 text-slate-400 font-mono text-xs sticky top-0 z-10">
                <tr>
                  <th className="p-3">Source File / Feature</th>
                  <th className="p-3">Geometry</th>
                  <th className="p-3">Coordinates / Vertices</th>
                  <th className="p-3">Assigned Layer Color</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {environmentFeatures.map((env, idx) => {
                  const isLine = ['ROAD', 'RAILWAY'].includes(env.envCategory);
                  return (
                  <tr key={env.id || idx} className="hover:bg-slate-800/30">
                    <td className="p-3">
                      <div className="font-bold text-emerald-400">{env.id || 'Unknown'}</div>
                      <div className="text-[11px] font-mono text-slate-500">{env.sourceFile || 'Uploaded KML'}</div>
                    </td>
                    <td className="p-3 font-mono text-xs text-slate-300 uppercase">
                      {env.isPolygon ? (isLine ? "POLYLINE" : "POLYGON") : "POINT"}
                    </td>
                    <td className="p-3 font-mono text-xs text-slate-400">
                      {env.isPolygon ? `${env.polygon?.length || 0} Vertices` : `${parseFloat(env.lat || 0).toFixed(4)}, ${parseFloat(env.lng || 0).toFixed(4)}`}
                    </td>
                    <td className="p-3 font-mono text-xs flex items-center space-x-2">
                      <span className="w-3.5 h-3.5 rounded-full border border-slate-500 shadow-sm inline-block" style={{ backgroundColor: env.color || '#3b82f6' }}></span>
                      <span className="text-slate-300 font-bold">{env.color || '#3b82f6'}</span>
                    </td>
                    <td className="p-3 text-right">
                      <button onClick={() => removeDevice(env.id)} className="text-slate-500 hover:text-rose-400">
                        <Trash2 className="w-4 h-4 inline" />
                      </button>
                    </td>
                  </tr>
                )})}
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
const ScenarioBuilderView = ({ scenario, setScenario, devices, sensorSchemas }) => {
  const [status, setStatus] = useState('');
  
  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeSchemas = Array.isArray(sensorSchemas) ? sensorSchemas : [];
  const safeActiveDevices = Array.isArray(scenario?.activeDevices) ? scenario.activeDevices : [];

  const configurableSensors = useMemo(() => safeDevices.filter(d => {
      if (!d || !d.type || String(d.type).toUpperCase().includes('ENV')) return false;
      const hasPacketChoice = !!d.packetChoice;
      const isMissingPacket = hasPacketChoice && !safeSchemas.some(s => s && s.name && String(s.name).toUpperCase() === String(d.packetChoice).toUpperCase());
      return !isMissingPacket; 
  }), [safeDevices, safeSchemas]);

  const allSensorIds = useMemo(() => configurableSensors.map(d => d.id).filter(Boolean), [configurableSensors]);
  const isAllSelected = allSensorIds.length > 0 && allSensorIds.every(id => safeActiveDevices.includes(id));
  
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

  const handleSave = async (e) => {
    e.preventDefault();
    if(!scenario || !Array.isArray(scenario.activeDevices) || scenario.activeDevices.length === 0) return alert("You must select at least one active sensor!");
    try {
        const response = await fetch('http://127.0.0.1:8000/api/state/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenario) });
        if (response.ok) {
            setStatus('Scenario compiled and State Saved to Database.');
            setTimeout(() => setStatus(''), 4000);
        }
    } catch (err) { alert("🚨 NETWORK CRASH:\nThe browser blocked the connection to Python.\n" + err.message); }
  };

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div><h2 className="text-2xl font-bold text-indigo-400 flex items-center space-x-2"><Sliders className="w-6 h-6" /> <span>Scenario Builder</span></h2></div>
        <span className="text-emerald-400 text-sm font-mono font-bold">{status && <><CheckCircle className="w-4 h-4 inline mr-2" />{status}</>}</span>
      </div>
      <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm md:col-span-2">
          <div>
            <label className="block text-xs font-mono text-slate-500 mb-1 uppercase tracking-wider">Mission Designation (Scenario Name)</label>
            <input type="text" name="name" required value={scenario?.name || ''} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded px-4 py-3 text-white text-lg font-bold focus:border-indigo-500 focus:outline-none" />
          </div>
        </div>
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
            {configurableSensors.length === 0 ? <div className="text-xs font-mono text-rose-400 p-3 bg-rose-950/20 border border-rose-900/50 rounded">No valid sensors loaded. Check missing formats.</div> : (
              configurableSensors.map(dev => {
                const isActive = (scenario?.activeDevices || []).includes(dev.id);
                return (
                <div key={dev.id} onClick={() => toggleDevice(dev.id)} className={`flex items-center justify-between p-3 rounded cursor-pointer border transition-colors ${isActive ? 'bg-indigo-950/40 border-indigo-500/50' : 'bg-slate-950 border-slate-800 hover:border-slate-700'}`}>
                  <div><span className={`text-sm font-bold ${isActive ? 'text-indigo-400' : 'text-slate-300'}`}>{dev.id}</span><span className="text-xs text-slate-500 ml-2 uppercase">({dev.type})</span></div>
                  <input type="checkbox" checked={isActive} readOnly className="w-4 h-4 accent-indigo-500" />
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
  const safeDevices = Array.isArray(devices) ? devices : [];
  
  // Cache the fleet calculation to stop CPU thrashing
  const activeFleet = useMemo(() => safeDevices.filter(d => d && (scenario?.activeDevices || []).includes(d.id)), [safeDevices, scenario]);
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
        <div><h2 className="text-2xl font-bold text-rose-400 flex items-center space-x-2"><BellDot className="w-6 h-6" /> <span>Alert Generator</span></h2><p className="text-slate-400 text-sm mt-1">Executing {targetTotalAlerts} total alerts across bounded sensor arrays.</p></div>
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

            {!simIsRunning ? ( <button onClick={startSimulation} className="w-full flex justify-center items-center space-x-2 bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded text-sm shadow-lg"><Play className="w-4 h-4 fill-current" /> <span>ENGAGE TRANSMITTER</span></button> ) : (
              <button onClick={stopSimulation} className="w-full flex justify-center items-center space-x-2 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded text-sm shadow-lg animate-pulse"><Square className="w-4 h-4 fill-current" /> <span>ABORT</span></button> )}
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
const MapView = ({ devices = [], alerts = [], simIsRunning, simProgress, totalAlertsGenerated }) => {
  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeAlerts = Array.isArray(alerts) ? alerts : [];

  const mapCenter = useMemo(() => safeDevices.length > 0 && safeDevices[0].lat ? [safeDevices[0].lat, safeDevices[0].lng] : [27.2285, 77.4320], [safeDevices]);
  
  const [showAll, setShowAll] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState({});

  useEffect(() => {
    if (simIsRunning) setShowAll(false);
  }, [simIsRunning]);

  const toggleLayer = (layerKey) => {
    setHiddenLayers(prev => ({ ...prev, [layerKey]: !prev[layerKey] }));
  };

  // Cache Map Arrays to stop massive DOM lag during simulation
  const kmlSources = useMemo(() => Array.from(new Set(
    safeDevices.filter(d => d && d.type && d.type.toUpperCase().includes('ENV')).map(d => d.sourceFile || 'Uploaded KML')
  )), [safeDevices]);

  const getSourceColor = (srcName) => {
    const match = safeDevices.find(d => (d.sourceFile || 'Uploaded KML') === srcName);
    return match ? (match.color || '#3b82f6') : '#3b82f6';
  };

  const visibleDevices = useMemo(() => safeDevices.filter(dev => {
    if (!dev || !dev.type) return false;
    if (dev.type.toUpperCase().includes('ENV')) {
      return !hiddenLayers[dev.sourceFile || 'Uploaded KML'];
    }
    return !hiddenLayers['HARDWARE_SENSORS'];
  }), [safeDevices, hiddenLayers]);

  const displayedAlerts = useMemo(() => 
    (showAll ? safeAlerts : safeAlerts.slice(-1000)).filter(() => !hiddenLayers['LIVE_ALERTS']), 
  [safeAlerts, showAll, hiddenLayers]);

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto h-[calc(100vh-4rem)] flex flex-col font-sans relative">
      <div className="border-b border-slate-800 pb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <Globe className="w-6 h-6 text-cyan-400" />
            <span>Tactical Map Visualizer</span>
          </h2>
        </div>
        <div className="flex space-x-3">
            <div className="flex items-center space-x-2 bg-rose-950/40 border border-rose-900 rounded px-3 py-1">
                <Target className="w-4 h-4 text-rose-500" />
                <span className="text-xs font-mono text-rose-400 font-bold">TOTAL GENERATED: {totalAlertsGenerated}</span>
            </div>
        </div>
      </div>

      <div className="flex-1 rounded-xl overflow-hidden border border-slate-700 shadow-2xl relative z-0 flex">
        <div className="absolute top-4 left-4 z-[1000] bg-slate-900/90 backdrop-blur border border-slate-700 rounded-lg shadow-2xl p-4 w-64 max-h-[80%] overflow-y-auto">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center">
              <FolderTree className="w-4 h-4 mr-2 text-cyan-400" /> Tactical Layers
            </h4>
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

        {safeAlerts.length > 1000 && !simIsRunning && (
            <div className="absolute top-4 right-4 z-[1000]">
                <button 
                    onClick={() => setShowAll(!showAll)}
                    className={`font-bold py-2 px-4 rounded shadow-lg text-xs flex items-center transition-colors ${showAll ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-rose-600 hover:bg-rose-500 text-white'}`}
                >
                    {showAll ? 'SHOW LATEST 1000 ONLY' : `LOAD ALL ${safeAlerts.length} ALERTS (MAY LAG)`}
                </button>
            </div>
        )}

        <MapContainer key={mapCenter.join(',')} center={mapCenter} zoom={13} className="h-full w-full" style={{ background: '#f8fafc' }} preferCanvas={true}>
          <TileLayer attribution='&copy; CartoDB' url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
          
          {visibleDevices.map((dev) => {
            if (!dev || !dev.type) return null;
            const isEnv = dev.type.toUpperCase().includes('ENV');
            const isCam = dev.type.toUpperCase().includes('CAM');
            const isRadar = dev.type.toUpperCase().includes('RADAR');
            const layerColor = dev.color || "#3b82f6";
            const safePoly = Array.isArray(dev.polygon) ? dev.polygon : [];
            const isLine = ['ROAD', 'RAILWAY'].includes(dev.envCategory);
            
            return (
              <React.Fragment key={dev.id || Math.random()}>
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
      const response = await fetch(`http://127.0.0.1:8000/api/export/run/${run.id}`);
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
      const response = await fetch('http://127.0.0.1:8000/api/export/range', {
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
  
  // Cache the filtered/sorted lists to stop UI lag
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
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold py-2.5 px-4 rounded text-xs flex items-center justify-center shadow-lg transition-colors"
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
                            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold px-4 py-2 rounded transition-colors text-xs flex items-center"
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
  const [currentView, setCurrentView] = useState('Device Configuration');
  const [dbStatus, setDbStatus] = useState('Checking...');
  const [sensorSchemas, setSensorSchemas] = useState([]); 
  const [devices, setDevices] = useState([]);
  const [scenario, setScenario] = useState({ name: 'Operation Alpha', activeDevices: [], udpIp: '127.0.0.1', udpPort: 5005 });
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

  const getAlertCount = (dev) => overrideCounts[dev.id] !== undefined ? overrideCounts[dev.id] : (dev.alertCount || 0);

  const fetchHistory = () => {
    fetch('http://127.0.0.1:8000/api/runs')
      .then(res => res.json()).then(data => { if(Array.isArray(data)) setCompletedRuns(data); })
      .catch(e => console.error("History fetch failed"));
  };

  useEffect(() => {
    fetch('http://127.0.0.1:8000/api/config/schemas')
      .then(res => { if (res.ok) { setDbStatus('CONNECTED'); return res.json(); } throw new Error(); })
      .then(data => { setSensorSchemas(Array.isArray(data) ? data : []); })
      .catch(e => setDbStatus('DISCONNECTED'));

    fetch('http://127.0.0.1:8000/api/config/devices')
      .then(res => res.json()).then(data => { setDevices(Array.isArray(data) ? data : []); }).catch(e => console.error(e));
      
    fetch('http://127.0.0.1:8000/api/state/scenario')
      .then(res => res.json()).then(data => { if(data && data.name) setScenario(data); }).catch(e => console.error(e));

    fetch('http://127.0.0.1:8000/api/state/alerts')
      .then(res => res.json()).then(data => { setActiveAlerts(Array.isArray(data) ? data : []); }).catch(e => console.error(e));

    fetchHistory();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
        fetch('http://127.0.0.1:8000/api/engine/status')
            .then(res => res.json())
            .then(data => {
                if(!data) return;
                setSimIsRunning(!!data.is_running);
                setSimProgress(data.progress || 0); 
                
                if (Array.isArray(data.logs) && data.logs.length > 0) {
                    setSimLogs(data.logs);
                }
                
                if (data.is_running || (Array.isArray(data.map_alerts) && data.map_alerts.length > 0)) {
                    setActiveAlerts(Array.isArray(data.map_alerts) ? data.map_alerts : []);
                }
                
                if (previousRunningState.current === true && data.is_running === false) {
                    fetchHistory();
                    fetch('http://127.0.0.1:8000/api/state/alerts')
                        .then(r => r.json())
                        .then(alerts => setActiveAlerts(Array.isArray(alerts) ? alerts : []));
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
    const environmentFleet = safeDevices.filter(d => d && d.type && String(d.type).toUpperCase().includes('ENV'));
    const targetTotalAlerts = activeFleet.reduce((acc, dev) => acc + getAlertCount(dev), 0);

    if (activeFleet.length === 0) return alert("MISSION ABORT: No active sensors bound.");
    if (targetTotalAlerts <= 0) return alert("MISSION ABORT: Target payload is 0.");

    setSimIsRunning(true);
    setSimProgress(0);
    setActiveAlerts([]);
    setSimLogs([{ time: new Date().toLocaleTimeString(), msg: `SYSTEM: Engaging '${scenario?.name || 'Simulation'}'. Requesting transmission...`, type: 'info' }]);

    const activeFleetWithOverrides = activeFleet.map(dev => ({ ...dev, alertCount: getAlertCount(dev) }));
    const payload = {
        scenarioName: scenario?.name || 'Simulation',
        udpIp: scenario?.udpIp || '127.0.0.1',
        udpPort: parseInt(scenario?.udpPort, 10) || 5005,
        activeDevices: activeFleetWithOverrides,
        environmentDevices: environmentFleet,
        alertConfig: alertConfig,
        sensorSchemas: Array.isArray(sensorSchemas) ? sensorSchemas : []
    };

    try {
        await fetch('http://127.0.0.1:8000/api/engine/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
    } catch (e) {
        setSimIsRunning(false);
        alert("Failed to start engine.");
    }
  };

  const stopSimulation = () => {
    fetch('http://127.0.0.1:8000/api/engine/stop', { method: 'POST' });
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
          {currentView === 'Scenario Builder' && <ScenarioBuilderView devices={devices} scenario={scenario} setScenario={setScenario} sensorSchemas={sensorSchemas} />}
          {currentView === 'Tactical Map' && <MapView devices={devices} alerts={activeAlerts} simIsRunning={simIsRunning} simProgress={simProgress} totalAlertsGenerated={totalAlertsGen} />}
          {currentView === 'Alert Generator' && <AlertGeneratorView devices={devices} scenario={scenario} alertConfig={alertConfig} setAlertConfig={setAlertConfig} setCompletedRuns={setCompletedRuns} setActiveAlerts={setActiveAlerts} sensorSchemas={sensorSchemas} simIsRunning={simIsRunning} simLogs={simLogs} simProgress={simProgress} startSimulation={startSimulation} stopSimulation={stopSimulation} overrideCounts={overrideCounts} setOverrideCounts={setOverrideCounts} getAlertCount={getAlertCount} />}
          {currentView === 'Reports / Export' && <ExportView completedRuns={completedRuns} />}
        </div>
      </main>
    </div>
  );
}