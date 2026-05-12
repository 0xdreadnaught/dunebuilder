<p align="center">
  <img src="dunebuilder_logo_512.png" alt="DuneBuilder Logo" width="128">
  <br>
  <strong>DuneBuilder</strong>
  <br>
 A PoB inspired tool for Dune: Awakening.
</p>


### Theorycrafting
<img width="1060" height="1098" alt="image" src="https://github.com/user-attachments/assets/703d1d22-140c-4d99-98f9-f01d08732e93" />
<img width="1060" height="1098" alt="image" src="https://github.com/user-attachments/assets/cc30b71e-ae72-425d-aed3-d922121fdb43" />
</br></br>

### QR Helper
[32char limit]
<img width="1060" height="1098" alt="image" src="https://github.com/user-attachments/assets/41bbbabf-8ce5-4cb6-958b-6e0d33951272" />
<img width="1481" height="1162" alt="image" src="https://github.com/user-attachments/assets/0044488a-9f9c-4ba5-8f38-b856d780ac64" />
</br></br>

### Engine.ini Editor
[drag & drop]
<img width="1060" height="1098" alt="image" src="https://github.com/user-attachments/assets/b2f43b23-7948-4e57-8c65-c1a70d8fccea" />



## Usage Notes:

Right click to specify stat values for ranged augment stats. 

There's a small x in the top left to remove them, ironing out a better solution. 

If you find bugs please report them. The calculations are done through extensive guess work based on available posts and manual testing. 

Most things are hidden by default, check settings.

Files are in `%APPDATA%\dunebuilder`.


## To-Do:

There are a handful of things planned but they need some more planning.


## Download

Grab the latest portable `.exe` from the [Releases](../../releases) page.


## Build from Source

**Prerequisites:** Node.js 18+ and npm

```bash
git clone https://github.com/0xdreadnaught/dunebuilder.git
cd dunebuilder
npm install
npm start
```

To create a portable Windows build:

```bash
npm run build
```

Output will be in the `dist/` folder.
