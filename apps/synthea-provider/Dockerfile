# syntax=docker/dockerfile:1.7

FROM eclipse-temurin:17-jdk-jammy AS build

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

WORKDIR /src/synthea
RUN ./gradlew --no-daemon shadowJar \
  && synthea_jar="$(find build/libs -name '*with-dependencies.jar' -print -quit)" \
  && test -n "${synthea_jar}" \
  && cp "${synthea_jar}" /tmp/synthea.jar

WORKDIR /src/provider
COPY ProviderServer.java synthea.properties ./
RUN javac -cp /tmp/synthea.jar -d /tmp/provider-classes ProviderServer.java

FROM eclipse-temurin:17-jre-jammy AS runtime

ENV SYNTHEA_CONFIG_PATH=/opt/provider/synthea.properties
ENV SYNTHEA_JAR_PATH=/opt/synthea/synthea.jar
ENV SYNTHEA_PROVIDER_PORT=51878
WORKDIR /opt/provider

RUN groupadd --gid 10001 synthea-provider \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent synthea-provider \
  && mkdir -p /opt/synthea /opt/licenses \
  && chown -R 10001:10001 /opt/provider /opt/synthea /opt/licenses
COPY --from=build --chown=10001:10001 /tmp/provider-classes/ ./
COPY --from=build --chown=10001:10001 /tmp/synthea.jar /opt/synthea/synthea.jar
COPY --from=build --chown=10001:10001 /src/provider/synthea.properties ./synthea.properties
COPY --from=build --chown=10001:10001 /src/synthea/LICENSE /opt/licenses/SYNTHEA-LICENSE
COPY --from=build --chown=10001:10001 /src/synthea/NOTICE /opt/licenses/SYNTHEA-NOTICE

USER 10001:10001
EXPOSE 51878
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["java", "-cp", "/opt/provider:/opt/synthea/synthea.jar", "ProviderServer", "--healthcheck"]
ENTRYPOINT ["java", "-cp", "/opt/provider:/opt/synthea/synthea.jar", "ProviderServer"]
