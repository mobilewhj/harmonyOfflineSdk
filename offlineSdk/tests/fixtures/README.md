# ZIP regression fixture

directory-nonempty.zip is an intentionally invalid generic ZIP input. It contains dist/index.html and a selected dist/assets/ directory whose metadata declares zero uncompressed bytes while its deflate stream has an actual nonempty body. The SDK must reject that directory during actual-content validation rather than trusting metadata.

The fixed bytes are1373 bytes, SHA2560c838ccfc64080fe99ff4d84c0cdf08cb4a241d29c6b9e226a5ea9c527aae9e4. This fixture is sample data for host regression tests; it is not an application offline package or a runtime-success example. Both affected test suites resolve it relative to this public tests directory and need no external validation tree.
