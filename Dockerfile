FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir ".[postgres]"
RUN mkdir -p /app/data/private
EXPOSE 8000
CMD ["uvicorn", "applygo.main:app", "--host", "0.0.0.0", "--port", "8000"]
