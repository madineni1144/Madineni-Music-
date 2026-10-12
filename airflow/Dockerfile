FROM apache/airflow:3.1.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER airflow

COPY --chown=airflow:0 audio_pipeline/requirements.txt /tmp/music-requirements.txt

RUN pip install --no-cache-dir \
    "apache-airflow==${AIRFLOW_VERSION}" \
    -r /tmp/music-requirements.txt \
    mutagen \
    pillow
