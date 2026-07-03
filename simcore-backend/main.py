import csv
import json
import math
import random
import socket
import time
import threading
import sys
import os
from io import StringIO
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Any

from geopy.distance import geodesic
from shapely.geometry import Polygon as ShapelyPolygon, LineString as ShapelyLineString, Point as ShapelyPoint
from database import SessionLocal, engine, Base, SimulationRun, AlertLog, DeviceConfigDB, SchemaConfigDB, ScenarioStateDB
from sqlalchemy.orm import Session

# ==========================================================
# SAFE MODULE LOADER FOR ALERT ENGINE (MUST BE HERE!)
# ==========================================================
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from src.alert_engine import AlertEngine
except ModuleNotFoundError:
    try:
        from alert_engine import AlertEngine
    except ModuleNotFoundError:
        raise RuntimeError(
            "CRITICAL: Could not find 'alert_engine.py'. Ensure it is saved in simcore-backend/"
        )
# ==========================================================

try:
    Base.metadata.create_all(bind=engine)
    print("SUCCESS: Connected to PostgreSQL Database.")
except Exception as e:
    print("\nWARNING: Could not connect to PostgreSQL Database:", e)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

app = FastAPI(title="SIMCORE v2.5 Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ==========================================================
# GLOBAL ENGINE STATE
# ==========================================================
engine_lock = threading.Lock()
engine_state = {
    "is_running": False,
    "should_abort": False,
    "progress": 0,
    "total": 0,
    "logs": [],
    "map_alerts": []
}

# Line 64: This will now succeed because AlertEngine is imported right above!
alert_engine = AlertEngine(max_queue_size=50000)

# ==========================================================
# PYDANTIC MODELS
# ==========================================================
class DeviceModel(BaseModel):
    id: str
    type: str
    lat: float = 0.0
    lng: float = 0.0
    innerRange: float = 0.0
    outerRange: float = 100.0
    azimuth: float = 0.0
    fov: float = 360.0
    alertCount: int = 0 
    packetChoice: str = "" 
    isPolygon: bool = False
    polygon: Optional[list] = []
    envCategory: Optional[str] = ""
    color: Optional[str] = "#888888"

class SchemaModel(BaseModel):
    name: str
    separator: str
    totalIndexes: int
    schema_data: list = Field(default=[], alias="schema")

class ScenarioModel(BaseModel):
    name: str
    activeDevices: list
    udpIp: str
    udpPort: int

class ExportRequest(BaseModel):
    scenarioName: str
    devices: List[DeviceModel]
    alerts: List[dict]

class RangeExportRequest(BaseModel):
    startTime: str
    endTime: str
    reportName: Optional[str] = "Time_Range_Report"

def generate_uniform_distance(min_range, max_range):
    return math.sqrt(random.uniform(min_range ** 2, max_range ** 2))

def determine_priority(distance):
    if distance <= 1500: return "HIGH"
    if distance <= 3500: return "MEDIUM"
    return "LOW"

# ==========================================================
# DYNAMIC PACKET BUILDER
# ==========================================================
def build_dynamic_packet(alert, device, track_id, schema, separator):
    clean_type = str(device.type).upper()
    if not schema:
        clean_id = str(device.id).replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        if "PIDS" in clean_type:
            packet = [clean_id, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1112, 0, 0, 0, 0, 0, track_id, 0]
            return ",".join(map(str, packet))
        elif "CAM" in clean_type:
            packet = [clean_id, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "Intrusion", 0, 0, 0]
            return ",".join(map(str, packet))
        else: 
            fov_start = (device.azimuth - (device.fov / 2)) % 360
            fov_end = (device.azimuth + (device.fov / 2)) % 360
            packet = [clean_id, 9, round(device.lat, 6), round(device.lng, 6), 0, round(device.azimuth, 2), round(fov_start, 2), round(fov_end, 2), track_id, round(alert["loc"][0], 8), round(alert["loc"][1], 8), round(alert.get("distance_m", 0), 2), round(alert.get("bearing", 0), 2), 0, 95, int(time.time()), 0, "", 0, 0, 0]
            return ",".join(map(str, packet))

    packet = []
    sorted_schema = sorted(schema, key=lambda x: x.get('index', 0))
    for field in sorted_schema:
        if field.get('staticValue') and str(field.get('staticValue')).strip() != "":
            packet.append(str(field.get('staticValue')).strip())
            continue

        fname = field.get('name', '').lower()
        dtype = field.get('dataType', '')
        val = 0 
        
        if 'deviceid' in fname or 'sensorid' in fname: val = str(device.id).replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        elif 'devicetype' in fname or 'sensortype' in fname: val = 9 if "RADAR" in clean_type else 10 if "CAM" in clean_type else 11
        elif 'devicelat' in fname or ('lat' in fname and 'target' not in fname): val = round(device.lat, 6)
        elif 'devicelong' in fname or 'devicelng' in fname or ('lon' in fname and 'target' not in fname): val = round(device.lng, 6)
        elif 'targetlat' in fname or 'alertlat' in fname: val = round(alert["loc"][0], 8)
        elif 'targetlong' in fname or 'alertlong' in fname: val = round(alert["loc"][1], 8)
        elif 'range' in fname or 'distance' in fname: val = round(alert.get("distance_m", 0), 2)
        elif 'bearing' in fname and 'device' not in fname: val = round(alert.get("bearing", 0), 2)
        elif 'trackid' in fname or 'nodeid' in fname: val = track_id
        elif 'time' in fname or 'timestamp' in fname: val = int(time.time())
        elif 'targettype' in fname: val = 0 
        elif 'otherinfo' in fname or 'analyticname' in fname: val = "Intrusion" if alert.get("priority") == 'HIGH' else "Motion"
        
        if dtype == 'Integer':
            try: val = int(float(val))
            except: val = 0
        elif dtype == 'Float/Double':
            try: val = float(val)
            except: val = 0.0
        elif dtype == 'String': val = str(val)
        elif dtype == 'Boolean': val = bool(val)
            
        packet.append(str(val))
    return separator.join(packet)

# ==========================================================
# SPATIAL REJECTION SAMPLING HELPER
# ==========================================================
def build_spatial_indices(env_devices):
    perimeters, buildings, vegetations, waterbodies, transport_lines = [], [], [], [], []
    for env in env_devices:
        cat = str(env.get("envCategory", "")).upper()
        poly_coords = env.get("polygon", [])
        if not poly_coords or len(poly_coords) < 2: continue
        
        shapely_coords = [(pt[1], pt[0]) for pt in poly_coords]
        try:
            if "PERIMETER" in cat:
                if len(shapely_coords) >= 3: perimeters.append(ShapelyPolygon(shapely_coords))
            elif "BUILDING" in cat:
                if len(shapely_coords) >= 3: buildings.append(ShapelyPolygon(shapely_coords))
            elif "VEGETATION" in cat:
                if len(shapely_coords) >= 3: vegetations.append(ShapelyPolygon(shapely_coords))
            elif "WATER" in cat:
                if len(shapely_coords) >= 3: waterbodies.append(ShapelyPolygon(shapely_coords))
            elif "ROAD" in cat or "RAIL" in cat:
                transport_lines.append(ShapelyLineString(shapely_coords))
        except Exception:
            continue
    return perimeters, buildings, vegetations, waterbodies, transport_lines

def sample_spatial_point(d_obj, perimeters, buildings, vegetations, waterbodies, transport_lines):
    clean_type = str(d_obj.type).upper()
    if "PIDS" in clean_type and d_obj.isPolygon and d_obj.polygon and len(d_obj.polygon) > 1:
        idx_poly = random.randint(0, len(d_obj.polygon) - 1)
        p1 = d_obj.polygon[idx_poly]; p2 = d_obj.polygon[(idx_poly + 1) % len(d_obj.polygon)]
        fraction = random.uniform(0, 1)
        edge_lat = p1[0] + fraction * (p2[0] - p1[0])
        edge_lng = p1[1] + fraction * (p2[1] - p1[1])
        offset_dist = random.uniform(0, 10)
        offset_bearing = random.uniform(0, 360)
        dest = geodesic(meters=offset_dist).destination((edge_lat, edge_lng), offset_bearing)
        return round(dest.latitude, 8), round(dest.longitude, 8), round(offset_dist, 2), round(offset_bearing, 2), "HIGH"

    for attempt in range(25):
        dist = generate_uniform_distance(d_obj.innerRange, d_obj.outerRange)
        bearing = random.uniform(d_obj.azimuth - (d_obj.fov / 2), d_obj.azimuth + (d_obj.fov / 2)) % 360 if "CAM" in clean_type else random.uniform(0, 360)
        dest = geodesic(meters=dist).destination((d_obj.lat, d_obj.lng), bearing)
        cand_lat, cand_lng = round(dest.latitude, 8), round(dest.longitude, 8)
        pt = ShapelyPoint(cand_lng, cand_lat)

        if perimeters and not any(poly.contains(pt) for poly in perimeters): continue
        if buildings and any(poly.contains(pt) for poly in buildings): continue

        prob = 0.35
        if transport_lines and any(line.distance(pt) < 0.00018 for line in transport_lines): prob = 0.95
        elif vegetations and any(poly.contains(pt) for poly in vegetations): prob = 0.85
        elif waterbodies and any(poly.contains(pt) for poly in waterbodies): prob = 0.08

        if random.random() <= prob:
            return cand_lat, cand_lng, round(dist, 2), round(bearing, 2), determine_priority(dist)

    return cand_lat, cand_lng, round(dist, 2), round(bearing, 2), determine_priority(dist)

# ==========================================================
# THE HIGH PERFORMANCE ENGINE WORKER
# ==========================================================
def simulation_worker(scenarioName, udpIp, udpPort, active_devices, env_devices, schemas, minDelay, maxDelay):
    global engine_state
    
    pool = []
    for dev in active_devices:
        count = int(dev.get('alertCount', 0))
        for _ in range(count):
            pool.append(dev)
            
    random.shuffle(pool)
    total = len(pool)

    with engine_lock:
        engine_state['is_running'] = True
        engine_state['should_abort'] = False
        engine_state['progress'] = 0
        engine_state['total'] = total
        engine_state['logs'] = [{"time": datetime.now().strftime("%H:%M:%S"), "msg": f"SYSTEM: Engaging '{scenarioName}'. UDP Engine Active with GIS Constraints.", "type": "info"}]
        engine_state['map_alerts'] = []

    if total == 0:
        with engine_lock: engine_state['is_running'] = False
        return

    perimeters, buildings, vegetations, waterbodies, transport_lines = build_spatial_indices(env_devices)
    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    # Dynamic UI batch step: updates every 1 packet if small burst (<50), else scales up to 25
    batch_step = 1 if total < 50 else min(25, max(1, total // 100))
    class DummyDev: pass

    for idx, dev_dict in enumerate(pool):
        with engine_lock:
            if engine_state['should_abort']:
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": "SYSTEM: Transmission Aborted manually.", "type": "error"})
                break

        d_obj = DummyDev()
        d_obj.id = dev_dict.get('id', '')
        d_obj.type = dev_dict.get('type', '')
        d_obj.lat = float(dev_dict.get('lat', 0.0))
        d_obj.lng = float(dev_dict.get('lng', 0.0))
        d_obj.innerRange = float(dev_dict.get('innerRange', 0.0))
        d_obj.outerRange = float(dev_dict.get('outerRange', 100.0))
        d_obj.azimuth = float(dev_dict.get('azimuth', 0.0))
        d_obj.fov = float(dev_dict.get('fov', 360.0))
        d_obj.isPolygon = bool(dev_dict.get('isPolygon', False))
        d_obj.polygon = dev_dict.get('polygon', [])
        d_obj.packetChoice = dev_dict.get('packetChoice', '')

        alert_lat, alert_lng, dist, bearing, priority = sample_spatial_point(d_obj, perimeters, buildings, vegetations, waterbodies, transport_lines)

        # [INTEGRATION] Use AlertEngine to emit ultra-lightweight alert reference (<200 bytes)
        alert_data = alert_engine.emit_alert(
            alert_type=str(d_obj.type).upper(),
            timestamp=time.time(),
            layer_id=scenarioName,
            feature_id=d_obj.id,
            trigger_lat=alert_lat,
            trigger_lon=alert_lng
        )
        alert_data["priority"] = priority
        alert_data["distance_m"] = dist
        alert_data["bearing"] = bearing
        alert_data["sensor_name"] = d_obj.id
        alert_data["sensor_type"] = str(d_obj.type).upper()
        alert_data["alert_id"] = idx + 1
        alert_data["timestamp"] = datetime.now(timezone.utc).isoformat()

        sel_schema = next((s['schema'] for s in schemas if s['name'].upper() == str(d_obj.packetChoice).upper()), None)
        sel_sep = next((s['separator'] for s in schemas if s['name'].upper() == str(d_obj.packetChoice).upper()), ",")

        packet_string = build_dynamic_packet(alert_data, d_obj, idx + 1, sel_schema, sel_sep)
        try:
            udp_socket.sendto(packet_string.encode('utf-8'), (str(udpIp), int(udpPort)))
        except Exception: pass

        if idx % batch_step == 0 or idx == total - 1:
            with engine_lock:
                engine_state['progress'] = idx + 1
                # Sync UI map strictly with last 1000 items in queue
                engine_state['map_alerts'] = alert_engine.alert_queue[-1000:]
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"[{d_obj.id}] -> {packet_string}", "type": "success"})
                if len(engine_state['logs']) > 50:
                    engine_state['logs'] = engine_state['logs'][:50]

        delay = random.uniform(float(minDelay), float(maxDelay))
        if delay > 0: time.sleep(delay)

    udp_socket.close()

    if not engine_state['should_abort']:
        with engine_lock:
            engine_state['progress'] = total
            engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"SYSTEM: Transmission Complete. {total} packets sent.", "type": "info"})
            engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"DATABASE: Writing batch records to PostgreSQL...", "type": "info"})

        db = SessionLocal()
        try:
            db_run = SimulationRun(
                scenario_name=scenarioName, total_alerts=total, 
                timestamp=datetime.now(timezone.utc).isoformat(),
                devices_snapshot=json.dumps(active_devices + env_devices) 
            )
            db.add(db_run)
            db.commit()
            db.refresh(db_run)

            # Flush remaining queue directly to database mappings
            chunk_size = 5000
            all_generated = alert_engine.alert_queue
            alert_dicts = []
            for a in all_generated:
                alert_dicts.append({
                    "run_id": db_run.id, "sensor_type": a["sensor_type"], "sensor_name": a["sensor_name"],
                    "alert_id": a["alert_id"], "priority": a["priority"], "latitude": a["loc"][0],
                    "longitude": a["loc"][1], "distance_m": a["distance_m"], "bearing": a["bearing"], "timestamp": a["timestamp"]
                })

            for i in range(0, len(alert_dicts), chunk_size):
                db.bulk_insert_mappings(AlertLog, alert_dicts[i:i+chunk_size])
            db.commit()

            with engine_lock:
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": "DATABASE: Successfully wrote 100% of data to Postgres history.", "type": "success"})

        except Exception as e:
            with engine_lock:
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"DB ERROR: {str(e)}", "type": "error"})
        finally: db.close()

    with engine_lock:
        engine_state['is_running'] = False

@app.post("/api/engine/start")
def api_engine_start(payload: dict):
    global engine_state
    with engine_lock:
        if engine_state["is_running"]: 
            return {"status": "error", "message": "Engine is already running."}
        engine_state["is_running"] = True
        engine_state["progress"] = 0
        engine_state["total"] = sum(int(d.get("alertCount", 0)) for d in payload.get("activeDevices", []))

    t = threading.Thread(
        target=simulation_worker,
        args=(
            payload["scenarioName"], payload["udpIp"], payload["udpPort"],
            payload["activeDevices"], payload["environmentDevices"], payload["sensorSchemas"],
            payload["alertConfig"]["minDelaySec"], payload["alertConfig"]["maxDelaySec"]
        ),
        daemon=True
    )
    t.start()
    return {"status": "success"}

@app.get("/api/engine/status")
def api_engine_status():
    with engine_lock:
        return {
            "is_running": engine_state["is_running"], "progress": engine_state["progress"],
            "total": engine_state["total"], "logs": engine_state["logs"], "map_alerts": engine_state["map_alerts"]
        }

@app.post("/api/engine/stop")
def api_engine_stop():
    with engine_lock: engine_state["should_abort"] = True
    return {"status": "success"}

@app.get("/api/state/alerts")
def get_active_alerts(db: Session = Depends(get_db)):
    last_run = db.query(SimulationRun).order_by(SimulationRun.id.desc()).first()
    if last_run:
        return [{
            "sensor_type": a.sensor_type, "sensor_name": a.sensor_name, "alert_id": a.alert_id,
            "priority": a.priority, "latitude": a.latitude, "longitude": a.longitude,
            "distance_m": a.distance_m, "bearing": a.bearing, "timestamp": a.timestamp
        } for a in last_run.alerts]
    return []

def compile_kml_and_csv(report_name: str, alerts: list, devices: list):
    csv_io = StringIO()
    writer = csv.writer(csv_io)
    writer.writerow(["sensor_type", "sensor_name", "alert_id", "priority", "latitude", "longitude", "distance_m", "bearing", "timestamp"])
    for alert in alerts:
        writer.writerow([alert["sensor_type"], alert["sensor_name"], alert["alert_id"], alert["priority"], alert.get("latitude", alert.get("loc", [0,0])[0]), alert.get("longitude", alert.get("loc", [0,0])[1]), alert.get("distance_m", 0), alert.get("bearing", 0), alert["timestamp"]])
    
    kml = f'<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n    <name>{report_name}</name>\n    <Style id="radarStyle"><IconStyle><color>ff0000ff</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="cameraStyle"><IconStyle><color>ffff0000</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="radarHighStyle"><IconStyle><color>ff0000ff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="radarMediumStyle"><IconStyle><color>ff00ffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="radarLowStyle"><IconStyle><color>ff00ff00</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraHighStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraMediumStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraLowStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="pidsAlertStyle"><IconStyle><color>ffffff00</color><scale>1.3</scale></IconStyle></Style>\n'
    
    for dev in devices:
        clean_type = str(dev.get("type", "")).upper()
        dev_id = dev.get("id", "Unknown")
        lat = float(dev.get("lat", 0.0))
        lng = float(dev.get("lng", 0.0))
        polygon = dev.get("polygon", [])
        
        if "ENV" in clean_type:
            hex_color = dev.get("color", "#888888").lstrip("#")
            kml_color = "ff" + hex_color[4:6] + hex_color[2:4] + hex_color[0:2]
            if len(polygon) >= 2:
                coords_str = " ".join([f"{pt[1]},{pt[0]},0" for pt in polygon])
                kml += f'<Placemark><name>{dev_id}</name><Style><LineStyle><color>{kml_color}</color><width>2.5</width></LineStyle><PolyStyle><color>66{kml_color[2:]}</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{coords_str}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
            else:
                kml += f'<Placemark><name>{dev_id}</name><Point><coordinates>{lng},{lat},0</coordinates></Point></Placemark>'
        elif dev.get("isPolygon") and polygon:
            perimeter_coords = " ".join([f"{pt[1]},{pt[0]},0" for pt in polygon]) + f" {polygon[0][1]},{polygon[0][0]},0"
            kml += f'<Placemark><name>{dev_id} Boundary</name><Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle><PolyStyle><color>440000ff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{perimeter_coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
        else:
            style = "#radarStyle" if "RADAR" in clean_type else "#cameraStyle"
            kml += f'<Placemark><name>{dev_id}</name><styleUrl>{style}</styleUrl><Point><coordinates>{lng},{lat},0</coordinates></Point></Placemark>'
            if "CAM" in clean_type:
                azimuth, fov, outerRange = float(dev.get("azimuth", 0.0)), float(dev.get("fov", 360.0)), float(dev.get("outerRange", 100.0))
                start_bearing, end_bearing = (azimuth - (fov / 2)) % 360, (azimuth + (fov / 2)) % 360
                arc_points = []
                angle = start_bearing
                while True:
                    pt = geodesic(meters=outerRange).destination((lat, lng), angle)
                    arc_points.append(f"{pt.longitude},{pt.latitude},0")
                    angle = (angle + 2) % 360
                    if abs((angle - end_bearing + 360) % 360) < 2: break
                kml += f'<Placemark><name>{dev_id} FOV</name><Style><LineStyle><color>66ff0000</color><width>1</width></LineStyle><PolyStyle><color>2200ff00</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{lng},{lat},0 {" ".join(arc_points)} {lng},{lat},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
            elif "RADAR" in clean_type:
                outerRange, innerRange = float(dev.get("outerRange", 100.0)), float(dev.get("innerRange", 0.0))
                outer_pts, inner_pts = [], []
                for angle in range(361):
                    opt = geodesic(meters=outerRange).destination((lat, lng), angle)
                    ipt = geodesic(meters=innerRange).destination((lat, lng), angle)
                    outer_pts.append(f"{opt.longitude},{opt.latitude},0")
                    inner_pts.append(f"{ipt.longitude},{ipt.latitude},0")
                kml += f'<Placemark><name>{dev_id} Boundary</name><LineString><coordinates>{" ".join(outer_pts)}</coordinates></LineString></Placemark><Placemark><name>{dev_id} Exclusion</name><LineString><coordinates>{" ".join(inner_pts)}</coordinates></LineString></Placemark>'

    for alert in alerts:
        clean_type = str(alert["sensor_type"]).upper()
        if "RADAR" in clean_type: style = "#radarHighStyle" if alert["priority"] == "HIGH" else "#radarMediumStyle" if alert["priority"] == "MEDIUM" else "#radarLowStyle"
        elif "PIDS" in clean_type: style = "#pidsAlertStyle"
        else: style = "#cameraHighStyle" if alert["priority"] == "HIGH" else "#cameraMediumStyle" if alert["priority"] == "MEDIUM" else "#cameraLowStyle"
        lat_val = alert.get("latitude", alert.get("loc", [0,0])[0])
        lng_val = alert.get("longitude", alert.get("loc", [0,0])[1])
        kml += f'<Placemark><name>{alert["sensor_name"]}_{alert["alert_id"]}</name><description>Priority: {alert["priority"]}\nDistance: {alert.get("distance_m", 0)}m\nTimestamp: {alert["timestamp"]}</description><styleUrl>{style}</styleUrl><Point><coordinates>{lng_val},{lat_val},0</coordinates></Point></Placemark>'
    
    kml += "\n</Document>\n</kml>"
    return {"csv_content": csv_io.getvalue(), "kml_content": kml}

@app.post("/api/export")
async def generate_exports(payload: ExportRequest, request: Request):
    dev_list = [{"id": d.id, "type": d.type, "lat": d.lat, "lng": d.lng, "innerRange": d.innerRange, "outerRange": d.outerRange, "azimuth": d.azimuth, "fov": d.fov, "isPolygon": d.isPolygon, "polygon": d.polygon, "color": d.color} for d in payload.devices]
    return compile_kml_and_csv(f"{payload.scenarioName} Report", payload.alerts, dev_list)

@app.post("/api/export/range")
def generate_range_exports(payload: RangeExportRequest, db: Session = Depends(get_db)):
    alerts_query = db.query(AlertLog).filter(AlertLog.timestamp >= payload.startTime, AlertLog.timestamp <= payload.endTime).all()
    alerts_list = [{
        "sensor_type": a.sensor_type, "sensor_name": a.sensor_name, "alert_id": a.alert_id,
        "priority": a.priority, "latitude": a.latitude, "longitude": a.longitude,
        "distance_m": a.distance_m, "bearing": a.bearing, "timestamp": a.timestamp
    } for a in alerts_query]

    devs_query = db.query(DeviceConfigDB).all()
    devs_list = [{"id": d.id, "type": d.type, "lat": d.lat, "lng": d.lng, "innerRange": d.innerRange, "outerRange": d.outerRange, "azimuth": d.azimuth, "fov": d.fov, "isPolygon": d.isPolygon, "polygon": json.loads(d.polygon) if d.polygon else []} for d in devs_query]
    return compile_kml_and_csv(payload.reportName or "Time_Range_Report", alerts_list, devs_list)

@app.get("/api/runs")
def get_all_runs(db: Session = Depends(get_db)):
    runs = db.query(SimulationRun).order_by(SimulationRun.id.desc()).all()
    result = []
    for r in runs:
        alerts = [{
            "sensor_type": a.sensor_type, "sensor_name": a.sensor_name, "alert_id": a.alert_id,
            "priority": a.priority, "latitude": a.latitude, "longitude": a.longitude,
            "distance_m": a.distance_m, "bearing": a.bearing, "timestamp": a.timestamp
        } for a in r.alerts]
        result.append({
            "id": r.id, "scenarioName": r.scenario_name, "alertsGenerated": r.total_alerts,
            "timestamp": r.timestamp, "devices": json.loads(r.devices_snapshot) if r.devices_snapshot else [],
            "alerts": alerts
        })
    return result

@app.get("/api/config/devices")
def get_saved_devices(db: Session = Depends(get_db)):
    devices = db.query(DeviceConfigDB).all()
    return [{"id": d.id, "type": d.type, "lat": d.lat, "lng": d.lng, "innerRange": d.innerRange, "outerRange": d.outerRange, "azimuth": d.azimuth, "fov": d.fov, "alertCount": d.alertCount, "packetChoice": d.packetChoice, "isPolygon": d.isPolygon, "polygon": json.loads(d.polygon) if d.polygon else []} for d in devices]

@app.post("/api/config/devices")
def save_devices(payload: List[DeviceModel], db: Session = Depends(get_db)):
    for dev in payload:
        try:
            db_dev = db.query(DeviceConfigDB).filter(DeviceConfigDB.id == dev.id).first()
            poly_str = json.dumps(dev.polygon) if dev.polygon else "[]"
            if db_dev:
                db_dev.type = str(dev.type); db_dev.lat = float(dev.lat); db_dev.lng = float(dev.lng); db_dev.innerRange = float(dev.innerRange); db_dev.outerRange = float(dev.outerRange); db_dev.azimuth = float(dev.azimuth); db_dev.fov = float(dev.fov); db_dev.alertCount = int(dev.alertCount); db_dev.packetChoice = str(dev.packetChoice); db_dev.isPolygon = bool(dev.isPolygon); db_dev.polygon = poly_str
            else:
                new_dev = DeviceConfigDB(id=str(dev.id), type=str(dev.type), lat=float(dev.lat), lng=float(dev.lng), innerRange=float(dev.innerRange), outerRange=float(dev.outerRange), azimuth=float(dev.azimuth), fov=float(dev.fov), alertCount=int(dev.alertCount), packetChoice=str(dev.packetChoice), isPolygon=bool(dev.isPolygon), polygon=poly_str)
                db.add(new_dev)
            db.commit()
        except Exception: db.rollback()
    return {"status": "success"}

@app.delete("/api/config/devices/{device_id}")
def delete_device(device_id: str, db: Session = Depends(get_db)):
    db.query(DeviceConfigDB).filter(DeviceConfigDB.id == device_id).delete()
    db.commit()
    return {"status": "success"}

@app.get("/api/config/schemas")
def get_saved_schemas(db: Session = Depends(get_db)):
    schemas = db.query(SchemaConfigDB).all()
    return [{"name": s.name, "separator": s.separator, "totalIndexes": s.totalIndexes, "schema": json.loads(s.schema_data) if s.schema_data else []} for s in schemas]

@app.post("/api/config/schemas")
def save_schemas(payload: List[SchemaModel], db: Session = Depends(get_db)):
    for s in payload:
        try:
            db_schema = db.query(SchemaConfigDB).filter(SchemaConfigDB.name == s.name).first()
            schema_str = json.dumps(s.schema_data) if s.schema_data else "[]"
            if db_schema:
                db_schema.separator = str(s.separator); db_schema.totalIndexes = int(s.totalIndexes); db_schema.schema_data = schema_str
            else:
                new_schema = SchemaConfigDB(name=str(s.name), separator=str(s.separator), totalIndexes=int(s.totalIndexes), schema_data=schema_str)
                db.add(new_schema)
            db.commit()
        except Exception: db.rollback()
    return {"status": "success"}

@app.delete("/api/config/schemas/{schema_name}")
def delete_schema(schema_name: str, db: Session = Depends(get_db)):
    db.query(SchemaConfigDB).filter(SchemaConfigDB.name == schema_name).delete()
    db.commit()
    return {"status": "success"}

@app.get("/api/state/scenario")
def get_scenario_state(db: Session = Depends(get_db)):
    s = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == "current").first()
    if s: return { "name": s.name, "activeDevices": json.loads(s.activeDevices), "udpIp": s.udpIp, "udpPort": s.udpPort }
    return { "name": "Operation Alpha", "activeDevices": [], "udpIp": "127.0.0.1", "udpPort": 5005 }

@app.post("/api/state/scenario")
def save_scenario_state(payload: ScenarioModel, db: Session = Depends(get_db)):
    s = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == "current").first()
    dev_str = json.dumps(payload.activeDevices)
    if s:
        s.name = payload.name; s.activeDevices = dev_str; s.udpIp = payload.udpIp; s.udpPort = payload.udpPort
    else:
        new_s = ScenarioStateDB(id="current", name=payload.name, activeDevices=dev_str, udpIp=payload.udpIp, udpPort=payload.udpPort)
        db.add(new_s)
    db.commit()
    return {"status": "success"}