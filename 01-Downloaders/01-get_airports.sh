# Download and unzip the airport database
wget https://www.partow.net/downloads/GlobalAirportDatabase.zip
unzip -o GlobalAirportDatabase.zip -d ../data/

# Remove unnecessary files
rm GlobalAirportDatabase.zip
rm ../data/readme.txt