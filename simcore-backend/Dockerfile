# /simcore-backend/Dockerfile

# 1. Base Python image
FROM python:3.10-slim

# 2. Set the working directory inside the container
WORKDIR /app

# 3. Install system dependencies required for Shapely and Psycopg2
RUN apt-get update && apt-get install -y \
    libpq-dev \
    gcc \
    libgeos-dev \
    && rm -rf /var/lib/apt/lists/*

# 4. Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 5. Copy the rest of the backend code
COPY . .

# 6. Expose the port FastAPI runs on
EXPOSE 8000

# 7. Start the server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]