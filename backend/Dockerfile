FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend

ENV THREADED_DATABASE_PATH=/data/threaded.sqlite3

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
