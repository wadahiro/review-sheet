# One annotated Python module, so `tests/goldens/extraction.json` pins the `py`
# parser's reading of every shape it understands. Nothing imports this; it is
# read, not run.

# @rs:config sheet: Storage

# @rs:category Application
MAX_CONNECTIONS = 100      # @rs Maximum connections @rs:default 50
TIMEOUT_SECONDS = 30       # @rs Timeout, seconds @rs:remarks the SLA is three
LOG_LEVEL = "INFO"         # @rs Log level @rs:default WARN

# @rs:category Object storage
BUCKET_NAME = "app-data-prod"   # @rs Bucket name @rs:remarks <app>-data-<env>
VERSIONED = True                # @rs Versioning @rs:default False

# @rs:category Capacity
settings = {
    "read_capacity": 25,          # @rs Read capacity @rs:default 5
    "removal_policy": "RETAIN",   # @rs Removal policy @rs:remarks RETAIN in production
}
