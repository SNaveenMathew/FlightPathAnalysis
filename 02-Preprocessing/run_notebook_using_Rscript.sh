Rscript -e "nbconvertR::nbconvert('"$1"', 'script')"
RFILE=$(echo $1 | sed -e "s/ipynb/r/g")
Rscript $RFILE
rm $RFILE
