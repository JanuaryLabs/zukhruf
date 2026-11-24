ARG BASE
FROM ${BASE}
ARG SERVER_VERSION
ARG REPOSITORY
USER root
RUN set -eux; \
    . /etc/os-release; \
    wget -qO /etc/apt/keyrings/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.asc] https://packages.microsoft.com/ubuntu/${VERSION_ID}/${REPOSITORY} ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/mssql-server.list; \
    apt-get update; \
    cd /tmp; \
    apt-get download "mssql-server-fts=${SERVER_VERSION}-*"; \
    dpkg --ignore-depends=mssql-server -i mssql-server-fts_*.deb; \
    rm -f mssql-server-fts_*.deb /etc/apt/sources.list.d/mssql-server.list; \
    rm -rf /var/lib/apt/lists/*
USER mssql
