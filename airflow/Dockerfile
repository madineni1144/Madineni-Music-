FROM apache/airflow:3.1.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER airflow

# Existing packages (unchanged).
RUN pip install --no-cache-dir \
    mutagen \
    pillow \
    openpyxl==3.1.5

# Packages imported by audio_pipeline/scripts/*.py. Declared explicitly so the
# pipeline does not depend on what the base image happens to bundle.
#   google-api-python-client, google-auth, google-auth-httplib2 -> Drive access
#   google-auth-oauthlib   -> google_oauth_bootstrap.py
#   psycopg2-binary        -> db.py
#   python-dotenv          -> db.py, send_email_summary.py
# The base image's installed versions are used as constraints, so this step
# fails loudly instead of silently changing Airflow's own dependencies.
# Exact pins for reproducible builds live in audio_pipeline/requirements.txt.
RUN pip freeze > /tmp/base-constraints.txt \
    && pip install --no-cache-dir -c /tmp/base-constraints.txt \
        google-api-python-client \
        google-auth \
        google-auth-httplib2 \
        google-auth-oauthlib \
        psycopg2-binary \
        python-dotenv \
    && rm -f /tmp/base-constraints.txt
