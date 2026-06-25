import csv
import json
import math
import random
import socket
import time
from io import StringIO
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Any

from geopy.distance import geodesic
from shapely.geometry import Polygon, Point
from database import SessionLocal, engine, Base, SimulationRun, AlertLog, DeviceConfigDB, SchemaConfigDB, ScenarioStateDB, ActiveAlertDB, TelemetryLogDB
from sqlalchemy.orm import Session
from fastapi import Depends

try:
    Base.metadata.create_all(bind=engine)
    print("SUCCESS: Connected to PostgreSQL Database (simcore_db5).")
except Exception as e:
    print("\nWARNING: Could not connect to PostgreSQL Database.")
    print("Ensure you created 'simcore_db5' in pgAdmin!\n")

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

app = FastAPI(title="SIMCORE v2.5 Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ==========================================================
# PYDANTIC MODELS
# ==========================================================
class DatabaseSaveRequest(BaseModel):
    scenarioName: str
    alerts: List[dict]
    devices: List[dict] = [] 

class DeviceModel(BaseModel):
    id: str
    type: str
    lat: float
    lng: float
    innerRange: float
    outerRange: float
    azimuth: float
    fov: float
    alertCount: int = 0 
    packetChoice: str = "" 
    isPolygon: bool = False
    polygon: Optional[list] = []

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

class TransmitRequest(BaseModel):
    targetIp: str
    targetPort: int
    trackId: int
    device: DeviceModel
    customSchema: Optional[list] = None
    customSeparator: Optional[str] = ","  

class ExportRequest(BaseModel):
    scenarioName: str
    devices: List[DeviceModel]
    alerts: List[dict]

def generate_uniform_distance(min_range, max_range):
    return math.sqrt(random.uniform(min_range ** 2, max_range ** 2))

def determine_priority(distance):
    if distance <= 1500: return "HIGH"
    if distance <= 3500: return "MEDIUM"
    return "LOW"

# ==========================================================
# MAGIC DYNAMIC PACKET BUILDER
# ==========================================================
def build_dynamic_packet(alert, device, track_id, schema, separator):
    if not schema:
        clean_id = device.id.replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        if device.type.upper() == "PIDS":
            packet = [clean_id, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1112, 0, 0, 0, 0, 0, track_id, 0]
            return ",".join(map(str, packet))
        elif device.type.upper() == "CAMERA":
            packet = [clean_id, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "Intrusion", 0, 0, 0]
            return ",".join(map(str, packet))
        else: 
            fov_start = (device.azimuth - (device.fov / 2)) % 360
            fov_end = (device.azimuth + (device.fov / 2)) % 360
            packet = [clean_id, 9, round(device.lat, 6), round(device.lng, 6), 0, round(device.azimuth, 2), round(fov_start, 2), round(fov_end, 2), track_id, round(alert["latitude"], 8), round(alert["longitude"], 8), round(alert["distance_m"], 2), round(alert["bearing"], 2), 0, 95, int(time.time()), 0, "", 0, 0, 0]
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
        
        if 'deviceid' in fname or 'sensorid' in fname: val = device.id.replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        elif 'devicetype' in fname or 'sensortype' in fname: val = 9 if device.type.lower() == "radar" else 10 if device.type.lower() == "camera" else 11
        elif 'devicelat' in fname or ('lat' in fname and 'target' not in fname): val = round(device.lat, 6)
        elif 'devicelong' in fname or 'devicelng' in fname or ('lon' in fname and 'target' not in fname): val = round(device.lng, 6)
        elif 'targetlat' in fname or 'alertlat' in fname: val = round(alert['latitude'], 8)
        elif 'targetlong' in fname or 'alertlong' in fname: val = round(alert['longitude'], 8)
        elif 'range' in fname or 'distance' in fname: val = round(alert['distance_m'], 2)
        elif 'bearing' in fname and 'device' not in fname: val = round(alert['bearing'], 2)
        elif 'trackid' in fname or 'nodeid' in fname: val = track_id
        elif 'time' in fname or 'timestamp' in fname: val = int(time.time())
        elif 'targettype' in fname: val = 0 
        elif 'otherinfo' in fname or 'analyticname' in fname: val = "Intrusion" if alert['priority'] == 'HIGH' else "Motion"
        
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

@app.post("/api/transmit")
async def calculate_and_transmit(payload: TransmitRequest):
    dev = payload.device
    if dev.type.upper() == "PIDS" and dev.isPolygon and dev.polygon and len(dev.polygon) > 1:
        idx = random.randint(0, len(dev.polygon) - 1)
        p1 = dev.polygon[idx]; p2 = dev.polygon[(idx + 1) % len(dev.polygon)]
        fraction = random.uniform(0, 1)
        edge_lat = p1[0] + fraction * (p2[0] - p1[0])
        edge_lng = p1[1] + fraction * (p2[1] - p1[1])
        offset_dist = random.uniform(0, 10)
        offset_bearing = random.uniform(0, 360)
        destination = geodesic(meters=offset_dist).destination((edge_lat, edge_lng), offset_bearing)
        alert_lat = round(destination.latitude, 8); alert_lng = round(destination.longitude, 8)
        distance = round(offset_dist, 2); bearing = round(offset_bearing, 2)
        priority = "HIGH"
    else:
        distance = generate_uniform_distance(dev.innerRange, dev.outerRange)
        bearing = random.uniform(dev.azimuth - (dev.fov / 2), dev.azimuth + (dev.fov / 2)) % 360 if dev.type.lower() == "camera" else random.uniform(0, 360)
        destination = geodesic(meters=distance).destination((dev.lat, dev.lng), bearing)
        alert_lat = round(destination.latitude, 8); alert_lng = round(destination.longitude, 8)
        priority = determine_priority(distance)

    alert_data = {
        "sensor_type": dev.type.upper(), "sensor_name": dev.id, "alert_id": payload.trackId,
        "priority": priority, "latitude": alert_lat, "longitude": alert_lng,
        "distance_m": round(distance, 2), "bearing": round(bearing, 2), "timestamp": datetime.now(timezone.utc).isoformat()
    }
    packet_string = build_dynamic_packet(alert_data, dev, payload.trackId, payload.customSchema, payload.customSeparator)
    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: udp_socket.sendto(packet_string.encode('utf-8'), (payload.targetIp, payload.targetPort))
    finally: udp_socket.close()
    return {"status": "success", "packet": packet_string, "alert_data": alert_data}

@app.post("/api/export")
async def generate_exports(payload: ExportRequest):
    csv_io = StringIO()
    writer = csv.writer(csv_io)
    writer.writerow(["sensor_type", "sensor_name", "alert_id", "priority", "latitude", "longitude", "distance_m", "bearing", "timestamp"])
    for alert in payload.alerts: writer.writerow([alert["sensor_type"], alert["sensor_name"], alert["alert_id"], alert["priority"], alert["latitude"], alert["longitude"], alert["distance_m"], alert["bearing"], alert["timestamp"]])
    
    kml = f'<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n    <name>{payload.scenarioName} Report</name>\n    <Style id="radarStyle"><IconStyle><color>ff0000ff</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="cameraStyle"><IconStyle><color>ffff0000</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="radarHighStyle"><IconStyle><color>ff0000ff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="radarMediumStyle"><IconStyle><color>ff00ffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="radarLowStyle"><IconStyle><color>ff00ff00</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraHighStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraMediumStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraLowStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="pidsAlertStyle"><IconStyle><color>ffffff00</color><scale>1.3</scale></IconStyle></Style>\n    <Style id="envStyle"><IconStyle><color>ff00ff00</color><scale>1.0</scale></IconStyle></Style>\n'
    for dev in payload.devices:
        if dev.type.lower() == "environment": kml += f'<Placemark><name>{dev.id}</name><styleUrl>#envStyle</styleUrl><Point><coordinates>{dev.lng},{dev.lat},0</coordinates></Point></Placemark>'
        elif dev.isPolygon and dev.polygon:
            perimeter_coords = " ".join([f"{pt[1]},{pt[0]},0" for pt in dev.polygon]) + f" {dev.polygon[0][1]},{dev.polygon[0][0]},0"
            kml += f'<Placemark><name>{dev.id} Boundary</name><Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle><PolyStyle><color>440000ff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{perimeter_coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
        else:
            style = "#radarStyle" if dev.type.lower() == "radar" else "#cameraStyle"
            kml += f'<Placemark><name>{dev.id}</name><styleUrl>{style}</styleUrl><Point><coordinates>{dev.lng},{dev.lat},0</coordinates></Point></Placemark>'
            if dev.type.lower() == "camera":
                start_bearing, end_bearing = (dev.azimuth - (dev.fov / 2)) % 360, (dev.azimuth + (dev.fov / 2)) % 360
                arc_points = []
                angle = start_bearing
                while True:
                    pt = geodesic(meters=dev.outerRange).destination((dev.lat, dev.lng), angle)
                    arc_points.append(f"{pt.longitude},{pt.latitude},0")
                    angle = (angle + 2) % 360
                    if abs((angle - end_bearing + 360) % 360) < 2: break
                kml += f'<Placemark><name>{dev.id} FOV</name><Style><LineStyle><color>66ff0000</color><width>1</width></LineStyle><PolyStyle><color>2200ff00</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{dev.lng},{dev.lat},0 {" ".join(arc_points)} {dev.lng},{dev.lat},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
            elif dev.type.lower() == "radar":
                outer_pts, inner_pts = [], []
                for angle in range(361):
                    opt = geodesic(meters=dev.outerRange).destination((dev.lat, dev.lng), angle)
                    ipt = geodesic(meters=dev.innerRange).destination((dev.lat, dev.lng), angle)
                    outer_pts.append(f"{opt.longitude},{opt.latitude},0")
                    inner_pts.append(f"{ipt.longitude},{ipt.latitude},0")
                kml += f'<Placemark><name>{dev.id} Boundary</name><LineString><coordinates>{" ".join(outer_pts)}</coordinates></LineString></Placemark><Placemark><name>{dev.id} Exclusion</name><LineString><coordinates>{" ".join(inner_pts)}</coordinates></LineString></Placemark>'

    for alert in payload.alerts:
        if alert["sensor_type"] == "RADAR": style = "#radarHighStyle" if alert["priority"] == "HIGH" else "#radarMediumStyle" if alert["priority"] == "MEDIUM" else "#radarLowStyle"
        elif alert["sensor_type"] == "PIDS": style = "#pidsAlertStyle"
        else: style = "#cameraHighStyle" if alert["priority"] == "HIGH" else "#cameraMediumStyle" if alert["priority"] == "MEDIUM" else "#cameraLowStyle"
        kml += f'<Placemark><name>{alert["sensor_name"]}_{alert["alert_id"]}</name><description>Priority: {alert["priority"]}\nDistance: {alert["distance_m"]}m\nTimestamp: {alert["timestamp"]}</description><styleUrl>{style}</styleUrl><Point><coordinates>{alert["longitude"]},{alert["latitude"]},0</coordinates></Point></Placemark>'
    kml += "\n</Document>\n</kml>"
    return {"csv_content": csv_io.getvalue(), "kml_content": kml}

@app.post("/api/database/save")
async def save_to_database(payload: DatabaseSaveRequest, db: Session = Depends(get_db)):
    try:
        db_run = SimulationRun(
            scenario_name=payload.scenarioName, 
            total_alerts=len(payload.alerts), 
            timestamp=datetime.now(timezone.utc).isoformat(),
            devices_snapshot=json.dumps(payload.devices) 
        )
        db.add(db_run); db.commit(); db.refresh(db_run) 
        for alert in payload.alerts:
            db_alert = AlertLog(
                run_id=db_run.id, sensor_type=alert["sensor_type"], sensor_name=alert["sensor_name"],
                alert_id=alert["alert_id"], priority=alert["priority"], latitude=alert["latitude"], 
                longitude=alert["longitude"], distance_m=alert["distance_m"], bearing=alert["bearing"], 
                timestamp=alert["timestamp"]
            )
            db.add(db_alert)
        db.commit()
        return {"status": "success", "message": f"Saved as Run #{db_run.id}"}
    except Exception as e:
        db.rollback()
        return {"status": "error", "message": str(e)}

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
            "id": r.id,
            "scenarioName": r.scenario_name,
            "alertsGenerated": r.total_alerts,
            "timestamp": r.timestamp,
            "devices": json.loads(r.devices_snapshot) if r.devices_snapshot else [],
            "alerts": alerts
        })
    return result

# ==========================================================
# DEVICE CONFIG PERSISTENCE
# ==========================================================
@app.get("/api/config/devices")
def get_saved_devices(db: Session = Depends(get_db)):
    devices = db.query(DeviceConfigDB).all()
    result = []
    for d in devices:
        result.append({
            "id": d.id, "type": d.type, "lat": d.lat, "lng": d.lng,
            "innerRange": d.innerRange, "outerRange": d.outerRange,
            "azimuth": d.azimuth, "fov": d.fov, "alertCount": d.alertCount,
            "packetChoice": d.packetChoice,
            "isPolygon": d.isPolygon, "polygon": json.loads(d.polygon) if d.polygon else []
        })
    return result

@app.post("/api/config/devices")
def save_devices(payload: List[DeviceModel], db: Session = Depends(get_db)):
    for dev in payload:
        try:
            db_dev = db.query(DeviceConfigDB).filter(DeviceConfigDB.id == dev.id).first()
            poly_str = json.dumps(dev.polygon) if dev.polygon else "[]"
            if db_dev:
                db_dev.type = str(dev.type)
                db_dev.lat = float(dev.lat)
                db_dev.lng = float(dev.lng)
                db_dev.innerRange = float(dev.innerRange)
                db_dev.outerRange = float(dev.outerRange)
                db_dev.azimuth = float(dev.azimuth)
                db_dev.fov = float(dev.fov)
                db_dev.alertCount = int(dev.alertCount)
                db_dev.packetChoice = str(dev.packetChoice)
                db_dev.isPolygon = bool(dev.isPolygon)
                db_dev.polygon = poly_str
            else:
                new_dev = DeviceConfigDB(
                    id=str(dev.id), type=str(dev.type), lat=float(dev.lat), lng=float(dev.lng),
                    innerRange=float(dev.innerRange), outerRange=float(dev.outerRange),
                    azimuth=float(dev.azimuth), fov=float(dev.fov), alertCount=int(dev.alertCount),
                    packetChoice=str(dev.packetChoice),
                    isPolygon=bool(dev.isPolygon), polygon=poly_str
                )
                db.add(new_dev)
            db.commit()
        except Exception as e:
            db.rollback()
    return {"status": "success"}

@app.delete("/api/config/devices/{device_id}")
def delete_device(device_id: str, db: Session = Depends(get_db)):
    db.query(DeviceConfigDB).filter(DeviceConfigDB.id == device_id).delete()
    db.commit()
    return {"status": "success"}

# ==========================================================
# SCHEMA CONFIG PERSISTENCE
# ==========================================================
@app.get("/api/config/schemas")
def get_saved_schemas(db: Session = Depends(get_db)):
    schemas = db.query(SchemaConfigDB).all()
    result = []
    for s in schemas:
        result.append({
            "name": s.name, "separator": s.separator, "totalIndexes": s.totalIndexes,
            "schema": json.loads(s.schema_data) if s.schema_data else []
        })
    return result

@app.post("/api/config/schemas")
def save_schemas(payload: List[SchemaModel], db: Session = Depends(get_db)):
    for s in payload:
        try:
            db_schema = db.query(SchemaConfigDB).filter(SchemaConfigDB.name == s.name).first()
            schema_str = json.dumps(s.schema_data) if s.schema_data else "[]"
            if db_schema:
                db_schema.separator = str(s.separator)
                db_schema.totalIndexes = int(s.totalIndexes)
                db_schema.schema_data = schema_str
            else:
                new_schema = SchemaConfigDB(
                    name=str(s.name), separator=str(s.separator), 
                    totalIndexes=int(s.totalIndexes), schema_data=schema_str
                )
                db.add(new_schema)
            db.commit()
        except Exception as e:
            db.rollback()
    return {"status": "success"}

@app.delete("/api/config/schemas/{schema_name}")
def delete_schema(schema_name: str, db: Session = Depends(get_db)):
    db.query(SchemaConfigDB).filter(SchemaConfigDB.name == schema_name).delete()
    db.commit()
    return {"status": "success"}

# ==========================================================
# LIVE STATE PERSISTENCE (SCENARIO & ALERTS)
# ==========================================================
@app.get("/api/state/scenario")
def get_scenario_state(db: Session = Depends(get_db)):
    s = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == "current").first()
    if s:
        return { "name": s.name, "activeDevices": json.loads(s.activeDevices), "udpIp": s.udpIp, "udpPort": s.udpPort }
    return { "name": "Operation Alpha", "activeDevices": [], "udpIp": "127.0.0.1", "udpPort": 5005 }

@app.post("/api/state/scenario")
def save_scenario_state(payload: ScenarioModel, db: Session = Depends(get_db)):
    s = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == "current").first()
    dev_str = json.dumps(payload.activeDevices)
    if s:
        s.name = payload.name; s.activeDevices = dev_str
        s.udpIp = payload.udpIp; s.udpPort = payload.udpPort
    else:
        new_s = ScenarioStateDB(id="current", name=payload.name, activeDevices=dev_str, udpIp=payload.udpIp, udpPort=payload.udpPort)
        db.add(new_s)
    db.commit()
    return {"status": "success"}

@app.get("/api/state/alerts")
def get_active_alerts(db: Session = Depends(get_db)):
    alerts = db.query(ActiveAlertDB).all()
    return [
        {
            "sensor_type": a.sensor_type, "sensor_name": a.sensor_name, "alert_id": a.alert_id,
            "priority": a.priority, "latitude": a.latitude, "longitude": a.longitude,
            "distance_m": a.distance_m, "bearing": a.bearing, "timestamp": a.timestamp
        } for a in alerts
    ]

@app.post("/api/state/alerts")
def save_active_alert(payload: dict, db: Session = Depends(get_db)):
    alert_id_str = f"{payload['sensor_name']}_{payload['alert_id']}_{payload['timestamp']}"
    new_alert = ActiveAlertDB(
        id=alert_id_str, sensor_type=payload["sensor_type"], sensor_name=payload["sensor_name"],
        alert_id=payload["alert_id"], priority=payload["priority"], latitude=payload["latitude"],
        longitude=payload["longitude"], distance_m=payload["distance_m"], bearing=payload["bearing"],
        timestamp=payload["timestamp"]
    )
    db.add(new_alert)
    db.commit()
    return {"status": "success"}

@app.delete("/api/state/alerts")
def clear_active_alerts(db: Session = Depends(get_db)):
    db.query(ActiveAlertDB).delete()
    db.commit()
    return {"status": "success"}

# ==========================================================
# TELEMETRY LOG PERSISTENCE (NEW)
# ==========================================================
@app.get("/api/state/logs")
def get_telemetry_logs(db: Session = Depends(get_db)):
    # Returns in reverse ID order, so [0] is the newest log (matches React state)
    logs = db.query(TelemetryLogDB).order_by(TelemetryLogDB.id.desc()).all()
    return [{"time": l.time, "msg": l.msg, "type": l.type} for l in logs]

@app.post("/api/state/logs")
def save_telemetry_log(payload: dict, db: Session = Depends(get_db)):
    new_log = TelemetryLogDB(
        time=payload.get("time", ""),
        msg=payload.get("msg", ""),
        type=payload.get("type", "info")
    )
    db.add(new_log)
    db.commit()
    return {"status": "success"}

@app.delete("/api/state/logs")
def clear_telemetry_logs(db: Session = Depends(get_db)):
    db.query(TelemetryLogDB).delete()
    db.commit()
    return {"status": "success"}