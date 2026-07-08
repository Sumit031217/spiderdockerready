from sqlalchemy import create_engine, Column, Integer, String, Float, ForeignKey, Boolean, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

# Database connection
SQLALCHEMY_DATABASE_URL = "postgresql://postgres:702073@localhost:5432/simcore_db5"

engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ==========================================
# SIMULATION HISTORY TABLES
# ==========================================
class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id = Column(Integer, primary_key=True, index=True)
    scenario_name = Column(String, index=True)
    total_alerts = Column(Integer)
    timestamp = Column(String)
    devices_snapshot = Column(Text, default="[]") 
    alerts = relationship("AlertLog", back_populates="run")

class AlertLog(Base):
    __tablename__ = "alert_logs"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("simulation_runs.id"))
    sensor_type = Column(String)
    sensor_name = Column(String)
    alert_id = Column(Integer) 
    priority = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)
    distance_m = Column(Float)
    bearing = Column(Float)
    timestamp = Column(String)
    run = relationship("SimulationRun", back_populates="alerts")

# ==========================================
# DEVICE CONFIGURATION TABLE
# ==========================================
class DeviceConfigDB(Base):
    __tablename__ = "device_configs"
    id = Column(String, primary_key=True, index=True)
    type = Column(String)
    lat = Column(Float)
    lng = Column(Float)
    innerRange = Column(Float)
    outerRange = Column(Float)
    azimuth = Column(Float)
    fov = Column(Float)
    alertCount = Column(Integer)
    packetChoice = Column(String)
    isPolygon = Column(Boolean)
    polygon = Column(Text)
    
    # [NEW COLUMNS] Added to stop PostgreSQL from stripping KML file names & colors
    envCategory = Column("envcategory", String, default="GENERAL")
    color = Column("color", String, default="#3b82f6")
    sourceFile = Column("sourcefile", String, default="Uploaded KML")

class SchemaConfigDB(Base):
    __tablename__ = "schema_configs"
    name = Column(String, primary_key=True, index=True)
    separator = Column(String)
    totalIndexes = Column(Integer)
    schema_data = Column(Text)  

# ==========================================
# LIVE STATE PERSISTENCE TABLES
# ==========================================
class ScenarioStateDB(Base):
    __tablename__ = "scenario_state"
    id = Column(String, primary_key=True, index=True) 
    name = Column(String)
    activeDevices = Column(Text) 
    udpIp = Column(String)
    udpPort = Column(Integer)

class ActiveAlertDB(Base):
    __tablename__ = "active_alerts"
    id = Column(String, primary_key=True, index=True)
    sensor_type = Column(String)
    sensor_name = Column(String)
    alert_id = Column(Integer)
    priority = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)
    distance_m = Column(Float)
    bearing = Column(Float)
    timestamp = Column(String)

class TelemetryLogDB(Base):
    __tablename__ = "telemetry_logs"
    id = Column(Integer, primary_key=True, index=True)
    time = Column(String)
    msg = Column(Text)
    type = Column(String)