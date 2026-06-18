from sqlalchemy import create_engine, Column, Integer, String, Float, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

# CHANGE 'password' TO YOUR ACTUAL POSTGRESQL PASSWORD
SQLALCHEMY_DATABASE_URL = "postgresql://postgres:702073@localhost:5432/simcore_db"

engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ==========================================
# TABLE 1: SIMULATION RUNS (The Mission)
# ==========================================
class SimulationRun(Base):
    __tablename__ = "simulation_runs"

    id = Column(Integer, primary_key=True, index=True)
    scenario_name = Column(String, index=True)
    total_alerts = Column(Integer)
    timestamp = Column(String)

    # Link to the alerts table
    alerts = relationship("AlertLog", back_populates="run")

# ==========================================
# TABLE 2: GENERATED ALERTS (The Threats)
# ==========================================
class AlertLog(Base):
    __tablename__ = "alert_logs"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("simulation_runs.id"))
    
    sensor_type = Column(String)
    sensor_name = Column(String)
    priority = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)
    distance_m = Column(Float)
    bearing = Column(Float)
    timestamp = Column(String)

    # Back-reference to the run
    run = relationship("SimulationRun", back_populates="alerts")