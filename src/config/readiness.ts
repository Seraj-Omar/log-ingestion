let ready=false;

export function markReady():void{
    ready=true;
}

export function isReady():boolean{
    return ready;
}