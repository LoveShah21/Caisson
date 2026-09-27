- platform: linux
- release: 6.6.87.2-microsoft-standard-WSL2
- architecture: x64
- node: v22.22.2
- docker: 29.8.0
- cpuModel: Intel(R) Core(TM) i5-10300H CPU @ 2.50GHz
- cpuCount: 8
- memoryBytes: 4020461568

On WSL2, `cpuCount` and `memoryBytes` describe the resources allocated to the Linux VM, not the physical resources of the Windows host.
