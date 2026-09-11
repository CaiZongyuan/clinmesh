# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM eclipse-temurin:17-jdk-jammy AS build

WORKDIR /src

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN synthea_commit=d9d07a6eef91ee5144293b42ab64224d84d124f8 \
  && synthea_archive_sha256=e5f097863440524935e8d1e081e66aea811692a66ba450d78e78e8a728f4722b \
  && curl --fail --location --silent --show-error \
    "https://github.com/synthetichealth/synthea/archive/${synthea_commit}.tar.gz" \
    --output /tmp/synthea.tar.gz \
  && echo "${synthea_archive_sha256}  /tmp/synthea.tar.gz" | sha256sum --check - \
  && mkdir synthea \
  && tar --extract --gzip --file /tmp/synthea.tar.gz --directory synthea --strip-components=1 \
  && rm /tmp/synthea.tar.gz
RUN cn_health_commit=518ab099061408bc4a6d4c8db8693756bef2fe84 \
  && profile_archive_sha256=615f777f61d6599a597651c4517cd7690b933efe0f74beb196ee3de5dd2913eb \
  && cn_health_license_sha256=0174a00c6dfceae24528f777821bb589bfdc22d184763ec756208f1cfd648dc5 \
  && cn_health_notice_sha256=616aefa83119c799df487f300ed9f937cd14f5f67b616d02c2400783f4e7364b \
  && curl --fail --location --silent --show-error \
    "https://github.com/CaiZongyuan/cn-health-data/releases/download/synthea-cn-2026-08-29.r4-preview.1/synthea-cn-profile.tar.gz" \
    --output /tmp/synthea-cn-profile.tar.gz \
  && curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/CaiZongyuan/cn-health-data/${cn_health_commit}/LICENSE" \
    --output /tmp/CN-HEALTH-DATA-LICENSE \
  && curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/CaiZongyuan/cn-health-data/${cn_health_commit}/DATA-NOTICE.md" \
    --output /tmp/CN-HEALTH-DATA-NOTICE \
  && echo "${profile_archive_sha256}  /tmp/synthea-cn-profile.tar.gz" \
    | sha256sum --check - \
  && echo "${cn_health_license_sha256}  /tmp/CN-HEALTH-DATA-LICENSE" \
    | sha256sum --check - \
  && echo "${cn_health_notice_sha256}  /tmp/CN-HEALTH-DATA-NOTICE" \
    | sha256sum --check - \
  && mkdir /tmp/synthea-profile \
  && tar --extract --gzip --file /tmp/synthea-cn-profile.tar.gz \
    --directory /tmp/synthea-profile --strip-components=1 \
  && rm /tmp/synthea-cn-profile.tar.gz

WORKDIR /src/synthea
RUN ./gradlew --no-daemon shadowJar \
  && synthea_jar="$(find build/libs -name '*with-dependencies.jar' -print -quit)" \
  && test -n "${synthea_jar}" \
  && cp "${synthea_jar}" /tmp/synthea.jar \
  && find src/main/resources/modules -type f -name '*.json' -print \
    | sed 's#^src/main/resources/modules/##; s#\.json$##' \
    | LC_ALL=C sort -u > /tmp/synthea-modules.txt \
  && test -s /tmp/synthea-modules.txt

WORKDIR /src/provider
COPY ProviderServer.java ./
RUN javac -cp /tmp/synthea.jar -d /tmp/provider-classes ProviderServer.java

FROM eclipse-temurin:17-jre-jammy AS runtime

ENV CN_HEALTH_LOCALIZER_URL=http://cn-health-localizer:51879/v1/localize
ENV SYNTHEA_CLASSPATH_PATH=/opt/cn-health/synthea-profile/classpath
ENV SYNTHEA_CONFIG_PATH=/opt/cn-health/synthea-profile/synthea.properties
ENV SYNTHEA_JAR_PATH=/opt/synthea/synthea.jar
ENV SYNTHEA_MODULES_PATH=/opt/synthea/modules.txt
ENV SYNTHEA_PROVIDER_PORT=51878
WORKDIR /opt/provider

RUN groupadd --gid 10001 synthea-provider \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent synthea-provider \
  && mkdir -p /opt/cn-health/synthea-profile /opt/synthea /opt/licenses \
  && chown -R 10001:10001 /opt/provider /opt/synthea /opt/licenses
COPY --from=build --chown=10001:10001 /tmp/provider-classes/ ./
COPY --from=build --chown=10001:10001 /tmp/synthea.jar /opt/synthea/synthea.jar
COPY --from=build --chown=10001:10001 /tmp/synthea-modules.txt /opt/synthea/modules.txt
COPY --from=build --chown=10001:10001 /src/synthea/LICENSE /opt/licenses/SYNTHEA-LICENSE
COPY --from=build --chown=10001:10001 /src/synthea/NOTICE /opt/licenses/SYNTHEA-NOTICE
COPY --from=build --chown=10001:10001 /tmp/synthea-profile /opt/cn-health/synthea-profile
COPY --from=build --chown=10001:10001 /tmp/CN-HEALTH-DATA-LICENSE /opt/licenses/CN-HEALTH-DATA-LICENSE
COPY --from=build --chown=10001:10001 /tmp/CN-HEALTH-DATA-NOTICE /opt/licenses/CN-HEALTH-DATA-NOTICE

USER 10001:10001
EXPOSE 51878
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["java", "-cp", "/opt/provider:/opt/synthea/synthea.jar", "ProviderServer", "--healthcheck"]
ENTRYPOINT ["java", "-cp", "/opt/provider:/opt/synthea/synthea.jar", "ProviderServer"]
