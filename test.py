import time
import sys

print("Test started", flush=True)
i = 0
while True:
    print(f"Running... {i}", flush=True)
    time.sleep(1)
    i += 1
    if i > 10:
        break
print("Test finished", flush=True)
