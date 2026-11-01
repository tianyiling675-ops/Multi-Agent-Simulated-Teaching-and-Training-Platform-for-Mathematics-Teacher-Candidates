FROM python:3.11-slim
WORKDIR /service
COPY requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY converter.py server.py ./
RUN useradd --create-home --uid 1002 converter
USER converter
ENV DOCUMENT_CONVERTER_HOST=0.0.0.0 DOCUMENT_CONVERTER_PORT=9040 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
EXPOSE 9040
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9040/health',timeout=2)"
CMD ["python", "server.py"]
