let ready=false;

export function markReady():void{
    ready=true;
}

export function markNotReady():void{
    ready=false;
}

export function isReady():boolean{
    return ready;
}
