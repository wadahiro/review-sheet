# A build whose reviewable values are the ones a reader signs: where it came
# from, what the process gets, what it exposes, who it runs as, what it runs.
FROM docker.io/library/eclipse-temurin:21-jre AS build
ARG APP_VERSION=1.4.2
ENV BUILD_HOME=/opt/build PATH=/opt/build/bin:$PATH
RUN ./gradlew --no-daemon installDist && rm -rf ~/.gradle

FROM docker.io/library/eclipse-temurin:21-jre
# The continued form is ONE instruction: two values, one line number.
ENV APP_DB=postgres \
    APP_HEALTH_ENABLED=true
# …and the older form, whose value runs to the end of the line.
ENV APP_BANNER a service, with commas, and spaces
LABEL org.opencontainers.image.title="Example service"
EXPOSE 8080
EXPOSE 9000
USER 1000
WORKDIR /opt/app
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://localhost:9000/health || exit 1
ENTRYPOINT ["/opt/app/bin/run"]
CMD ["--server"]
