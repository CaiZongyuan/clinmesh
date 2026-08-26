import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

public final class ProviderServer {
  private static final String SYNTHEA_COMMIT =
      "d9d07a6eef91ee5144293b42ab64224d84d124f8";
  private static final Path SYNTHEA_JAR = Path.of("/opt/synthea/synthea.jar");
  private static final Path SYNTHEA_CONFIG = Path.of("/opt/provider/synthea.properties");
  private static final int MAX_REQUEST_BYTES = 64 * 1024;
  private static final int MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  private static final Gson GSON = new Gson();
  private static final Set<String> MODULES = Set.of("fever", "type-2-diabetes");

  private record GenerationRequest(
      List<String> modules,
      String name,
      int count,
      int minimumAge,
      int maximumAge,
      String gender,
      long populationSeed,
      long clinicalSeed,
      LocalDate start,
      LocalDate end,
      String timeZone) {}

  private static final class RequestException extends Exception {
    private final String code;

    private RequestException(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  private ProviderServer() {}

  public static void main(String[] args) throws Exception {
    if (args.length == 1 && args[0].equals("--healthcheck")) {
      healthcheck();
      return;
    }
    if (args.length == 1 && args[0].equals("--smoke")) {
      smoke();
      return;
    }
    if (args.length != 0) throw new IllegalArgumentException("Unsupported Provider argument");

    int port = Integer.parseInt(System.getenv().getOrDefault("SYNTHEA_PROVIDER_PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
    server.createContext("/health", ProviderServer::handleHealth);
    server.createContext("/v1/generate", ProviderServer::handleGenerate);
    server.setExecutor(Executors.newSingleThreadExecutor());
    server.start();
    System.out.printf("Synthea Provider %s listening on port %d%n", SYNTHEA_COMMIT, port);
  }

  private static void handleHealth(HttpExchange exchange) throws IOException {
    if (!exchange.getRequestMethod().equals("GET")) {
      sendError(exchange, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed");
      return;
    }
    JsonObject body = new JsonObject();
    body.addProperty("status", "ok");
    body.addProperty("syntheaCommit", SYNTHEA_COMMIT);
    sendJson(exchange, 200, body);
  }

  private static void handleGenerate(HttpExchange exchange) throws IOException {
    if (!exchange.getRequestMethod().equals("POST")) {
      sendError(exchange, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed");
      return;
    }
    String contentType = exchange.getRequestHeaders().getFirst("content-type");
    if (contentType == null || !contentType.toLowerCase().startsWith("application/json")) {
      sendError(exchange, 415, "CONTENT_TYPE_INVALID", "application/json is required");
      return;
    }
    try {
      byte[] requestBytes = exchange.getRequestBody().readNBytes(MAX_REQUEST_BYTES + 1);
      if (requestBytes.length > MAX_REQUEST_BYTES) {
        throw new RequestException("REQUEST_TOO_LARGE", "The request exceeds 64 KiB");
      }
      GenerationRequest request = parseRequest(new String(requestBytes, StandardCharsets.UTF_8));
      JsonObject response = generate(request);
      byte[] responseBytes = GSON.toJson(response).getBytes(StandardCharsets.UTF_8);
      if (responseBytes.length > MAX_RESPONSE_BYTES) {
        sendError(exchange, 413, "RESPONSE_TOO_LARGE", "Generated data exceeds 64 MiB");
        return;
      }
      sendJson(exchange, 200, responseBytes);
    } catch (RequestException error) {
      sendError(exchange, 400, error.code, error.getMessage());
    } catch (Exception error) {
      System.err.printf("Synthea generation failed: %s%n", error.getMessage());
      sendError(exchange, 502, "GENERATION_FAILED", "Synthea generation failed");
    }
  }

  private static GenerationRequest parseRequest(String json) throws RequestException {
    JsonObject root;
    try {
      root = JsonParser.parseString(json).getAsJsonObject();
    } catch (RuntimeException error) {
      throw new RequestException("REQUEST_INVALID", "The request must be a JSON object");
    }
    requireKeys(root, Set.of(
        "modules", "name", "population", "providerId", "seeds", "timeRange", "timeZone"),
        "request");
    requireString(root, "providerId", 1, 20, "synthea");
    String name = requireString(root, "name", 1, 120, null);
    String timeZone = requireString(root, "timeZone", 1, 40, "Asia/Shanghai");

    JsonArray moduleValues = requireArray(root, "modules", 1, 2);
    List<String> modules = new ArrayList<>();
    for (JsonElement value : moduleValues) {
      if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
        throw new RequestException("REQUEST_INVALID", "modules must contain strings");
      }
      String module = value.getAsString();
      if (!MODULES.contains(module) || modules.contains(module)) {
        throw new RequestException("REQUEST_INVALID", "modules contains an unsupported value");
      }
      modules.add(module);
    }

    JsonObject population = requireObject(root, "population");
    requireKeys(population, Set.of("age", "count", "gender"), "population");
    int count = requireInteger(population, "count", 1, 50);
    String gender = requireString(population, "gender", 1, 10, null);
    if (!Set.of("any", "female", "male").contains(gender)) {
      throw new RequestException("REQUEST_INVALID", "gender is unsupported");
    }
    JsonObject age = requireObject(population, "age");
    requireKeys(age, Set.of("maximum", "minimum"), "population.age");
    int minimumAge = requireInteger(age, "minimum", 0, 120);
    int maximumAge = requireInteger(age, "maximum", 0, 120);
    if (minimumAge > maximumAge) {
      throw new RequestException("REQUEST_INVALID", "minimum age exceeds maximum age");
    }

    JsonObject seeds = requireObject(root, "seeds");
    requireKeys(seeds, Set.of("clinical", "population"), "seeds");
    long clinicalSeed = requireLong(seeds, "clinical", 0, Integer.MAX_VALUE);
    long populationSeed = requireLong(seeds, "population", 0, Integer.MAX_VALUE);

    JsonObject timeRange = requireObject(root, "timeRange");
    requireKeys(timeRange, Set.of("end", "start"), "timeRange");
    LocalDate start = requireDate(timeRange, "start");
    LocalDate end = requireDate(timeRange, "end");
    if (start.isAfter(end)) {
      throw new RequestException("REQUEST_INVALID", "history start is after history end");
    }
    return new GenerationRequest(
        modules, name, count, minimumAge, maximumAge, gender,
        populationSeed, clinicalSeed, start, end, timeZone);
  }

  private static JsonObject generate(GenerationRequest request) throws Exception {
    Path workingDirectory = Files.createTempDirectory("clinmesh-synthea-");
    Path outputDirectory = workingDirectory.resolve("output");
    try {
      List<String> command = new ArrayList<>();
      command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
      command.add("-Duser.timezone=" + request.timeZone);
      command.add("-jar");
      command.add(SYNTHEA_JAR.toString());
      command.add("-c");
      command.add(SYNTHEA_CONFIG.toString());
      command.add("-p");
      command.add(Integer.toString(request.count));
      command.add("-s");
      command.add(Long.toString(request.populationSeed));
      command.add("-cs");
      command.add(Long.toString(request.clinicalSeed));
      command.add("-r");
      command.add(request.end.toString().replace("-", ""));
      command.add("-e");
      command.add(request.end.toString().replace("-", ""));
      command.add("-a");
      command.add(String.format("%d-%d", request.minimumAge, request.maximumAge));
      if (!request.gender.equals("any")) {
        command.add("-g");
        command.add(request.gender.equals("female") ? "F" : "M");
      }
      command.add("-m");
      command.add(String.join(File.pathSeparator, modulePatterns(request.modules)));
      command.add("--exporter.baseDirectory=" + outputDirectory);
      long historyDays = ChronoUnit.DAYS.between(request.start, request.end) + 1;
      command.add("--exporter.years_of_history=" + Math.max(1, (historyDays + 364) / 365));
      command.add("Massachusetts");

      Process process = new ProcessBuilder(command)
          .directory(workingDirectory.toFile())
          .redirectOutput(ProcessBuilder.Redirect.INHERIT)
          .redirectError(ProcessBuilder.Redirect.INHERIT)
          .start();
      if (!process.waitFor(10, TimeUnit.MINUTES)) {
        process.destroyForcibly();
        throw new IOException("Synthea exceeded the ten minute execution limit");
      }
      if (process.exitValue() != 0) {
        throw new IOException("Synthea exited with status " + process.exitValue());
      }

      JsonArray bundles = new JsonArray();
      Path fhirDirectory = outputDirectory.resolve("fhir");
      if (!Files.isDirectory(fhirDirectory)) throw new IOException("FHIR output directory is missing");
      try (Stream<Path> paths = Files.list(fhirDirectory)) {
        for (Path path : paths.filter(Files::isRegularFile).sorted().toList()) {
          JsonElement value = JsonParser.parseString(Files.readString(path));
          if (isPatientBundle(value)) {
            bundles.add(trimBundleToTimeRange(value.getAsJsonObject(), request));
          }
        }
      }
      if (bundles.size() != request.count) {
        throw new IOException("Synthea returned an unexpected Patient Bundle count");
      }

      JsonObject metadata = new JsonObject();
      metadata.addProperty("clinicalSeed", request.clinicalSeed);
      metadata.addProperty("configHash", sha256(SYNTHEA_CONFIG));
      metadata.add("modules", GSON.toJsonTree(request.modules));
      metadata.addProperty("populationSeed", request.populationSeed);
      metadata.addProperty("syntheaCommit", SYNTHEA_COMMIT);
      JsonObject timeRange = new JsonObject();
      timeRange.addProperty("end", request.end.toString());
      timeRange.addProperty("start", request.start.toString());
      metadata.add("timeRange", timeRange);
      metadata.addProperty("timeZone", request.timeZone);
      JsonObject response = new JsonObject();
      response.add("bundles", bundles);
      response.add("metadata", metadata);
      return response;
    } finally {
      deleteRecursively(workingDirectory);
    }
  }

  private static List<String> modulePatterns(List<String> modules) {
    List<String> patterns = new ArrayList<>();
    if (modules.contains("fever")) patterns.add("sinusitis.json");
    if (modules.contains("type-2-diabetes")) {
      patterns.add("metabolic_syndrome_disease.json");
      patterns.add("metabolic_syndrome_care.json");
      patterns.add("metabolic_syndrome/*.json");
    }
    return patterns;
  }

  private static boolean isPatientBundle(JsonElement value) {
    if (!value.isJsonObject()) return false;
    JsonObject bundle = value.getAsJsonObject();
    if (!bundle.has("resourceType") || !bundle.get("resourceType").getAsString().equals("Bundle")) {
      return false;
    }
    if (!bundle.has("entry") || !bundle.get("entry").isJsonArray()) return false;
    for (JsonElement entryValue : bundle.getAsJsonArray("entry")) {
      if (!entryValue.isJsonObject()) continue;
      JsonObject entry = entryValue.getAsJsonObject();
      if (!entry.has("resource") || !entry.get("resource").isJsonObject()) continue;
      JsonObject resource = entry.getAsJsonObject("resource");
      if (resource.has("resourceType")
          && resource.get("resourceType").getAsString().equals("Patient")) return true;
    }
    return false;
  }

  private static JsonObject trimBundleToTimeRange(
      JsonObject bundle, GenerationRequest request) throws IOException {
    JsonArray retainedEntries = new JsonArray();
    for (JsonElement entryValue : bundle.getAsJsonArray("entry")) {
      JsonObject entry = entryValue.getAsJsonObject();
      JsonObject resource = entry.getAsJsonObject("resource");
      if (isWithinTimeRange(resource, request)) retainedEntries.add(entry);
    }
    bundle.add("entry", retainedEntries);
    pruneDanglingReferences(bundle);
    return bundle;
  }

  private static boolean isWithinTimeRange(
      JsonObject resource, GenerationRequest request) throws IOException {
    if (!resource.has("resourceType")) return true;
    List<List<String>> datePaths = switch (resource.get("resourceType").getAsString()) {
      case "AllergyIntolerance" -> List.of(List.of("recordedDate"));
      case "Condition" -> List.of(List.of("onsetDateTime"), List.of("recordedDate"));
      case "Encounter" -> List.of(List.of("period", "start"), List.of("period", "end"));
      case "MedicationRequest" -> List.of(List.of("authoredOn"));
      case "Observation" -> List.of(List.of("effectiveDateTime"));
      default -> List.of();
    };
    for (List<String> path : datePaths) {
      String value = nestedString(resource, path);
      if (value == null) continue;
      LocalDate date = clinicalDate(value, request.timeZone);
      if (date.isBefore(request.start) || date.isAfter(request.end)) return false;
    }
    return true;
  }

  private static String nestedString(JsonObject root, List<String> path) {
    JsonElement current = root;
    for (String key : path) {
      if (!current.isJsonObject() || !current.getAsJsonObject().has(key)) return null;
      current = current.getAsJsonObject().get(key);
    }
    return current.isJsonPrimitive() && current.getAsJsonPrimitive().isString()
        ? current.getAsString()
        : null;
  }

  private static LocalDate clinicalDate(String value, String timeZone) throws IOException {
    try {
      return OffsetDateTime.parse(value)
          .atZoneSameInstant(ZoneId.of(timeZone))
          .toLocalDate();
    } catch (DateTimeParseException error) {
      try {
        return LocalDate.parse(value);
      } catch (DateTimeParseException nestedError) {
        throw new IOException("Synthea returned an invalid clinical date", nestedError);
      }
    }
  }

  private static void pruneDanglingReferences(JsonObject bundle) {
    boolean removed;
    do {
      JsonArray entries = bundle.getAsJsonArray("entry");
      Set<String> identities = new HashSet<>();
      for (JsonElement entryValue : entries) {
        JsonObject entry = entryValue.getAsJsonObject();
        if (entry.has("fullUrl")) identities.add(entry.get("fullUrl").getAsString());
        JsonObject resource = entry.getAsJsonObject("resource");
        identities.add(
            resource.get("resourceType").getAsString() + "/" + resource.get("id").getAsString());
      }

      JsonArray retainedEntries = new JsonArray();
      removed = false;
      for (JsonElement entryValue : entries) {
        JsonObject resource = entryValue.getAsJsonObject().getAsJsonObject("resource");
        if (hasDanglingReference(resource, identities)) {
          removed = true;
        } else {
          retainedEntries.add(entryValue);
        }
      }
      bundle.add("entry", retainedEntries);
    } while (removed);
  }

  private static boolean hasDanglingReference(JsonElement value, Set<String> identities) {
    if (value.isJsonArray()) {
      for (JsonElement item : value.getAsJsonArray()) {
        if (hasDanglingReference(item, identities)) return true;
      }
      return false;
    }
    if (!value.isJsonObject()) return false;
    for (String key : value.getAsJsonObject().keySet()) {
      JsonElement child = value.getAsJsonObject().get(key);
      if (key.equals("reference") && child.isJsonPrimitive()
          && child.getAsJsonPrimitive().isString()) {
        String reference = child.getAsString();
        if (!reference.startsWith("#") && !identities.contains(reference)) return true;
      } else if (hasDanglingReference(child, identities)) {
        return true;
      }
    }
    return false;
  }

  private static void requireKeys(JsonObject value, Set<String> expected, String path)
      throws RequestException {
    if (!value.keySet().equals(expected)) {
      throw new RequestException("REQUEST_INVALID", path + " contains unsupported or missing fields");
    }
  }

  private static JsonObject requireObject(JsonObject parent, String key) throws RequestException {
    if (!parent.has(key) || !parent.get(key).isJsonObject()) {
      throw new RequestException("REQUEST_INVALID", key + " must be an object");
    }
    return parent.getAsJsonObject(key);
  }

  private static JsonArray requireArray(JsonObject parent, String key, int minimum, int maximum)
      throws RequestException {
    if (!parent.has(key) || !parent.get(key).isJsonArray()) {
      throw new RequestException("REQUEST_INVALID", key + " must be an array");
    }
    JsonArray value = parent.getAsJsonArray(key);
    if (value.size() < minimum || value.size() > maximum) {
      throw new RequestException("REQUEST_INVALID", key + " has an invalid size");
    }
    return value;
  }

  private static String requireString(
      JsonObject parent, String key, int minimum, int maximum, String exact)
      throws RequestException {
    if (!parent.has(key) || !parent.get(key).isJsonPrimitive()
        || !parent.getAsJsonPrimitive(key).isString()) {
      throw new RequestException("REQUEST_INVALID", key + " must be a string");
    }
    String value = parent.get(key).getAsString();
    if (value.length() < minimum || value.length() > maximum
        || (exact != null && !value.equals(exact))) {
      throw new RequestException("REQUEST_INVALID", key + " has an invalid value");
    }
    return value;
  }

  private static int requireInteger(JsonObject parent, String key, int minimum, int maximum)
      throws RequestException {
    long value = requireLong(parent, key, minimum, maximum);
    return Math.toIntExact(value);
  }

  private static long requireLong(JsonObject parent, String key, long minimum, long maximum)
      throws RequestException {
    try {
      if (!parent.has(key) || !parent.get(key).isJsonPrimitive()
          || !parent.getAsJsonPrimitive(key).isNumber()) throw new NumberFormatException();
      long value = parent.get(key).getAsLong();
      if (value < minimum || value > maximum) throw new NumberFormatException();
      return value;
    } catch (RuntimeException error) {
      throw new RequestException("REQUEST_INVALID", key + " must be a bounded integer");
    }
  }

  private static LocalDate requireDate(JsonObject parent, String key) throws RequestException {
    try {
      return LocalDate.parse(requireString(parent, key, 10, 10, null));
    } catch (RuntimeException error) {
      throw new RequestException("REQUEST_INVALID", key + " must be an ISO date");
    }
  }

  private static String sha256(Path path) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path)));
  }

  private static void deleteRecursively(Path root) {
    if (!Files.exists(root)) return;
    try (Stream<Path> paths = Files.walk(root)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
        Files.deleteIfExists(path);
      }
    } catch (IOException error) {
      System.err.printf("Failed to remove temporary Synthea output: %s%n", error.getMessage());
    }
  }

  private static void sendError(
      HttpExchange exchange, int status, String code, String message) throws IOException {
    JsonObject error = new JsonObject();
    error.addProperty("code", code);
    error.addProperty("message", message);
    JsonObject body = new JsonObject();
    body.add("error", error);
    sendJson(exchange, status, body);
  }

  private static void sendJson(HttpExchange exchange, int status, JsonElement body)
      throws IOException {
    sendJson(exchange, status, GSON.toJson(body).getBytes(StandardCharsets.UTF_8));
  }

  private static void sendJson(HttpExchange exchange, int status, byte[] body) throws IOException {
    exchange.getResponseHeaders().set("content-type", "application/json; charset=utf-8");
    exchange.sendResponseHeaders(status, body.length);
    exchange.getResponseBody().write(body);
    exchange.close();
  }

  private static void healthcheck() throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("SYNTHEA_PROVIDER_PORT", "8080"));
    HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health"))
        .timeout(Duration.ofSeconds(2))
        .GET()
        .build();
    HttpResponse<String> response = HttpClient.newHttpClient()
        .send(request, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() != 200 || !response.body().contains(SYNTHEA_COMMIT)) {
      throw new IOException("Synthea Provider healthcheck failed");
    }
  }

  private static void smoke() throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("SYNTHEA_PROVIDER_PORT", "8080"));
    String body = """
        {"modules":["fever"],"name":"Docker smoke","population":{"age":{"maximum":40,"minimum":30},"count":1,"gender":"any"},"providerId":"synthea","seeds":{"clinical":7331,"population":4242},"timeRange":{"end":"2026-08-01","start":"2020-01-01"},"timeZone":"Asia/Shanghai"}
        """.trim();
    HttpRequest request = HttpRequest.newBuilder(
            URI.create("http://127.0.0.1:" + port + "/v1/generate"))
        .timeout(Duration.ofMinutes(10))
        .header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build();
    HttpResponse<String> response = HttpClient.newHttpClient()
        .send(request, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() != 200) throw new IOException("Synthea Provider smoke request failed");
    JsonObject result = JsonParser.parseString(response.body()).getAsJsonObject();
    if (result.getAsJsonArray("bundles").size() != 1
        || !result.getAsJsonObject("metadata").get("syntheaCommit").getAsString()
            .equals(SYNTHEA_COMMIT)) {
      throw new IOException("Synthea Provider smoke response is invalid");
    }
    System.out.println("Synthea Provider smoke passed");
  }
}
